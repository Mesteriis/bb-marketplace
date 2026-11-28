import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommanderError } from "../../core/errors.ts";
import {
  FrameDecoder, encodeControl, encodeData, type Frame,
} from "../../core/wire/archive-protocol.ts";
import { ArchiveHelperClient, type HelperProcess } from "./archive-helper.ts";

class FakeProcess extends EventEmitter implements HelperProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  signals: string[] = [];
  received: Frame[] = [];
  private decoder = new FrameDecoder("from-adapter");
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) this.received.push(frame);
    });
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
  say(...frames: Uint8Array[]) {
    for (const frame of frames) this.stdout.write(frame);
  }
  hello(over: Record<string, unknown> = {}) {
    this.say(encodeControl({ t: "hello", protocol: 1, helper: "0.1.0", zip: "8.6.0", tar: "0.4.46", rlimit_as: "not_enforced", ...over }));
  }
  async nextControl(): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const found = this.received.find((f) => f.kind === "control");
      if (found && found.kind === "control") {
        this.received.splice(this.received.indexOf(found), 1);
        return found.json;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("no control frame");
  }
}

const OPTIONS = {
  binPath: "/x/commander-archive-helper", helperVersion: "0.1.0", platform: "darwin", arch: "arm64",
  handshakeTimeoutMs: 100, requestTimeoutMs: 100, killGraceMs: 10,
} as const;

function setup(over: Partial<ConstructorParameters<typeof ArchiveHelperClient>[0]> = {}) {
  const proc = new FakeProcess();
  const spawn = vi.fn(() => proc);
  const client = new ArchiveHelperClient({
    ...OPTIONS, spawn, integrity: () => ({ ok: true }), ...over,
  });
  return { proc, spawn, client };
}

const reason = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommanderError) return `${error.code}+${error.reason}`;
    throw error;
  }
  return "no error";
};

afterEach(() => vi.useRealTimers());

describe("starting the helper", () => {
  it("rejects start() itself with protocol_error when the first frame is not a hello (no hang)", async () => {
    const { client, proc } = setup({ handshakeTimeoutMs: 60_000 });
    const started = client.start();
    proc.say(encodeControl({ t: "ok", req: 1 }));
    expect(await reason(started)).toBe("internal+protocol_error");
    expect(proc.signals).toContain("SIGKILL");
  });
  it("rejects start() with protocol_error when the first frame is data", async () => {
    const { client, proc } = setup({ handshakeTimeoutMs: 60_000 });
    const started = client.start();
    proc.say(encodeData(1, Uint8Array.from([1])));
    expect(await reason(started)).toBe("internal+protocol_error");
  });
  it("refuses other platforms without spawning", async () => {
    const { client, spawn } = setup({ platform: "linux" });
    expect(await reason(client.start())).toBe("unsupported+archives_unavailable");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("refuses x64 macOS without spawning", async () => {
    const { client, spawn } = setup({ arch: "x64" });
    expect(await reason(client.start())).toBe("unsupported+archives_unavailable");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("does not spawn when the checksum check fails", async () => {
    const { client, spawn } = setup({ integrity: () => ({ ok: false, code: "helper_checksum_failed", reason: "mismatch" }) });
    expect(await reason(client.start())).toBe("internal+helper_checksum_failed");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("completes the handshake and passes no arguments or environment secrets", async () => {
    const { client, proc, spawn } = setup();
    const started = client.start();
    proc.hello();
    await expect(started).resolves.toMatchObject({ rlimitAs: "not_enforced" });
    expect(spawn).toHaveBeenCalledWith("/x/commander-archive-helper", [], { env: { PATH: "/usr/bin:/bin" } });
  });
  it("kills the helper on a protocol or version mismatch", async () => {
    for (const [over, expected] of [
      [{ protocol: 2 }, "internal+helper_version_mismatch"],
      [{ helper: "9.9.9" }, "internal+helper_version_mismatch"],
    ] as const) {
      const { client, proc } = setup();
      const started = client.start();
      proc.hello(over);
      expect(await reason(started)).toBe(expected);
      expect(proc.signals).toContain("SIGKILL");
    }
  });
  it("times out the handshake", async () => {
    const { client, proc } = setup();
    expect(await reason(client.start())).toBe("internal+helper_crashed");
    expect(proc.signals).toContain("SIGKILL");
  });
});

describe("requests", () => {
  async function ready() {
    const s = setup();
    const started = s.client.start();
    s.proc.hello();
    await started;
    return s;
  }
  it("correlates an ok response and returns the data frames of that request", async () => {
    const { client, proc } = await ready();
    const pending = client.request({ t: "read", stream: 1, length: 3 });
    const sent = await proc.nextControl();
    expect(sent).toMatchObject({ t: "read", stream: 1, length: 3, req: 1 });
    proc.say(encodeData(1, Uint8Array.from([1, 2, 3])), encodeControl({ t: "ok", req: 1, pos: 3 }));
    const result = await pending;
    expect(result.json).toMatchObject({ t: "ok", pos: 3 });
    expect([...result.data[0]!]).toEqual([1, 2, 3]);
  });
  it("maps an error response to CommanderError with code and reason", async () => {
    const { client, proc } = await ready();
    const pending = client.request({ t: "stat", nameB64: "YQ==" });
    await proc.nextControl();
    proc.say(encodeControl({ t: "err", req: 1, code: "invalid_archive", reason: "duplicate_name", message: "dup" }));
    expect(await reason(pending)).toBe("invalid_archive+duplicate_name");
  });
  it("treats a response for an unknown request as a protocol error: SIGKILL and helper_crashed", async () => {
    const { client, proc } = await ready();
    const pending = client.request({ t: "verify" });
    await proc.nextControl();
    proc.say(encodeControl({ t: "ok", req: 99 }));
    expect(await reason(pending)).toBe("internal+protocol_error");
    expect(proc.signals).toContain("SIGKILL");
  });
  it("treats data without a waiting request and a second hello as protocol errors", async () => {
    const a = await ready();
    const first = reason(a.client.request({ t: "verify" }));
    await a.proc.nextControl();
    a.proc.say(encodeData(5, Uint8Array.from([1])));
    expect(await first).toBe("internal+protocol_error");
    const b = await ready();
    const second = reason(b.client.request({ t: "verify" }));
    await b.proc.nextControl();
    b.proc.hello();
    expect(await second).toBe("internal+protocol_error");
  });
  it("fails the waiting request with helper_crashed on EOF or exit", async () => {
    const { client, proc } = await ready();
    const pending = client.request({ t: "verify" });
    await proc.nextControl();
    proc.emit("exit", 137, null);
    expect(await reason(pending)).toBe("internal+helper_crashed");
  });
  it("kills the helper and fails the request after the per-request timeout", async () => {
    const { client, proc } = await ready();
    const pending = client.request({ t: "verify" });
    await proc.nextControl();
    expect(await reason(pending)).toBe("internal+helper_crashed");
    expect(proc.signals).toContain("SIGKILL");
  });
  it("sends one request at a time, in order", async () => {
    const { client, proc } = await ready();
    const one = client.request({ t: "verify" });
    const two = client.request({ t: "close" });
    expect(await proc.nextControl()).toMatchObject({ t: "verify", req: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(proc.received).toHaveLength(0);
    proc.say(encodeControl({ t: "ok", req: 1 }));
    await one;
    expect(await proc.nextControl()).toMatchObject({ t: "close", req: 2 });
    proc.say(encodeControl({ t: "ok", req: 2 }));
    await two;
  });
  it("aborts a request with cancel and cancelled", async () => {
    const { client, proc } = await ready();
    const controller = new AbortController();
    const pending = client.request({ t: "verify" }, { signal: controller.signal });
    await proc.nextControl();
    controller.abort();
    expect(await proc.nextControl()).toMatchObject({ t: "cancel", target: 1 });
    proc.say(encodeControl({ t: "err", req: 1, code: "cancelled", message: "c" }));
    expect(await reason(pending)).toBe("cancelled+undefined");
  });
});

describe("answers to our own cancel", () => {
  async function ready() {
    const s = setup();
    const started = s.client.start();
    s.proc.hello();
    await started;
    return s;
  }
  it("accepts the ok that answers a cancel, in either order, and stays usable after three cancels", async () => {
    const { client, proc } = await ready();
    for (let round = 0; round < 3; round++) {
      const controller = new AbortController();
      const target = round * 2 + 1;
      const pending = client.request({ t: "verify" }, { signal: controller.signal });
      await proc.nextControl();
      controller.abort();
      const cancel = await proc.nextControl();
      expect(cancel).toMatchObject({ t: "cancel", target });
      if (round % 2 === 0) {
        proc.say(encodeControl({ t: "ok", req: cancel.req }), encodeControl({ t: "err", req: target, code: "cancelled", message: "c" }));
      } else {
        proc.say(encodeControl({ t: "err", req: target, code: "cancelled", message: "c" }), encodeControl({ t: "ok", req: cancel.req }));
      }
      expect(await reason(pending)).toBe("cancelled+undefined");
    }
    const after = client.request({ t: "verify" });
    const sent = await proc.nextControl();
    proc.say(encodeControl({ t: "ok", req: sent.req }));
    await expect(after).resolves.toBeDefined();
    expect(proc.signals).toEqual([]);
  });
});

describe("requests with a payload", () => {
  it("sends the data frame with the same request id right after the control frame", async () => {
    const s = setup();
    const started = s.client.start();
    s.proc.hello();
    await started;
    const pending = s.client.request({ t: "pack_data" }, { data: Uint8Array.from([7, 8, 9]) });
    expect(await s.proc.nextControl()).toMatchObject({ t: "pack_data", req: 1 });
    for (let i = 0; i < 100 && s.proc.received.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(s.proc.received[0]).toMatchObject({ kind: "data", reqId: 1 });
    expect([...(s.proc.received[0] as { bytes: Uint8Array }).bytes]).toEqual([7, 8, 9]);
    s.proc.say(encodeControl({ t: "ok", req: 1, written: "3" }));
    await pending;
  });
});

describe("password timing and wiping", () => {
  it("does not kill a request that waits for the owner's password, even past the request timeout", async () => {
    const s = setup({ requestTimeoutMs: 60, passwordWaitMs: 5000 });
    const started = s.client.start();
    s.proc.hello();
    await started;
    const pending = s.client.request({ t: "read_open", id: 0 }, {
      password: () => new Promise((resolve) => setTimeout(() => resolve(Uint8Array.from([0x70, 0x77])), 250)),
    });
    await s.proc.nextControl();
    s.proc.say(encodeControl({ t: "need_password", req: 1 }));
    for (let i = 0; i < 200 && !s.proc.received.some((f) => f.kind === "secret"); i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.proc.received.find((f) => f.kind === "secret")).toMatchObject({ reqId: 1, length: 2 });
    s.proc.say(encodeControl({ t: "ok", req: 1 }));
    await expect(pending).resolves.toBeDefined();
    expect(s.proc.signals).toEqual([]);
  });
  it("gives up when the dialog is silent for the password wait", async () => {
    const s = setup({ requestTimeoutMs: 1000, passwordWaitMs: 60 });
    const started = s.client.start();
    s.proc.hello();
    await started;
    const pending = s.client.request({ t: "read_open", id: 0 }, { password: () => new Promise(() => {}) });
    await s.proc.nextControl();
    s.proc.say(encodeControl({ t: "need_password", req: 1 }));
    expect(await reason(pending)).toBe("internal+helper_crashed");
  });
  it("wipes the secret frame buffer itself once it has been written", async () => {
    const s = setup();
    const started = s.client.start();
    s.proc.hello();
    await started;
    const writes: Array<{ chunk: Uint8Array; seen: number[]; done: Promise<void> }> = [];
    const original = s.proc.stdin.write.bind(s.proc.stdin);
    (s.proc.stdin as unknown as { write: unknown }).write = (chunk: Uint8Array, cb?: () => void) => {
      let done!: () => void;
      const wait = new Promise<void>((r) => { done = r; });
      writes.push({ chunk, seen: [...chunk], done: wait });
      return original(chunk, () => { cb?.(); done(); });
    };
    const pending = s.client.request({ t: "read_open", id: 0 }, { password: async () => Uint8Array.from([0x70, 0x77, 0x31]) });
    await s.proc.nextControl();
    s.proc.say(encodeControl({ t: "need_password", req: 1 }));
    for (let i = 0; i < 200 && writes.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    const secret = writes.find((w) => w.seen[4] === 0x03)!;
    await secret.done;
    await new Promise((r) => setTimeout(r, 5));
    expect(secret.seen.slice(9)).toEqual([0x70, 0x77, 0x31]);
    expect([...secret.chunk]).toEqual(new Array(secret.chunk.length).fill(0));
    s.proc.say(encodeControl({ t: "ok", req: 1 }));
    await pending;
  });
});

describe("password", () => {
  it("answers need_password with a secret frame, clears the buffer and never prints it", async () => {
    const s = setup();
    const started = s.client.start();
    s.proc.hello();
    await started;
    const password = Uint8Array.from([0x70, 0x77, 0x31]);
    const pending = s.client.request({ t: "read_open", id: 0 }, { password: async () => password });
    await s.proc.nextControl();
    s.proc.say(encodeControl({ t: "need_password", req: 1 }));
    for (let i = 0; i < 100 && s.proc.received.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    const secret = s.proc.received.find((f) => f.kind === "secret");
    expect(secret).toMatchObject({ kind: "secret", reqId: 1, length: 3 });
    expect([...password]).toEqual([0, 0, 0]);
    s.proc.say(encodeControl({ t: "ok", req: 1, stream: 1, size: "3" }));
    await pending;
  });
  it("answers need_password with a one-byte placeholder when there is no password and reports password_required", async () => {
    const s = setup();
    const started = s.client.start();
    s.proc.hello();
    await started;
    const pending = s.client.request({ t: "read_open", id: 0 });
    await s.proc.nextControl();
    s.proc.say(encodeControl({ t: "need_password", req: 1 }));
    for (let i = 0; i < 100 && s.proc.received.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(s.proc.received[0]).toMatchObject({ kind: "secret", reqId: 1, length: 1 });
    s.proc.say(encodeControl({ t: "err", req: 1, code: "auth_failed", reason: "bad_password", message: "wrong" }));
    expect(await reason(pending)).toBe("auth_failed+password_required");
  });
});

describe("stderr", () => {
  it("keeps at most 64 KiB", async () => {
    const s = setup();
    const started = s.client.start();
    s.proc.hello();
    await started;
    s.proc.stderr.write("x".repeat(100_000));
    await new Promise((r) => setTimeout(r, 5));
    expect(s.client.stderrTail().length).toBe(65536);
  });
});

describe("memory watchdog", () => {
  it("terminates the helper with SIGTERM then fails requests when RSS passes the limit", async () => {
    const readRss = vi.fn(async () => 600 * 1024 * 1024);
    const s = setup({ rssLimitBytes: 512 * 1024 * 1024, readRss, rssPollMs: 5 });
    const started = s.client.start();
    s.proc.hello();
    await started;
    const pending = s.client.request({ t: "verify" });
    await s.proc.nextControl();
    expect(await reason(pending)).toBe("internal+helper_crashed");
    expect(s.proc.signals[0]).toBe("SIGTERM");
  });
  it("leaves a helper under the limit alone", async () => {
    const readRss = vi.fn(async () => 100 * 1024 * 1024);
    const s = setup({ rssLimitBytes: 512 * 1024 * 1024, readRss, rssPollMs: 5 });
    const started = s.client.start();
    s.proc.hello();
    await started;
    await new Promise((r) => setTimeout(r, 30));
    expect(readRss).toHaveBeenCalled();
    expect(s.proc.signals).toEqual([]);
  });
});
