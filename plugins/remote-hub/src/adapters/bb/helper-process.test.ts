import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeControlFrame,
  encodeStreamFrame,
  type ControlMessage,
} from "../../core/protocol.ts";
import {
  HELPER_BIN_NAME,
  HelperProcess,
  helperBinaryPath,
  parseHelperVersion,
  platformError,
  probeHelper,
  type HelperSpawn,
} from "./helper-process.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FakeChild {
  child: EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => void };
  writes: Buffer[];
}

function makeFakeChild(): FakeChild {
  const writes: Buffer[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callback();
    },
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as FakeChild["child"];
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => {};
  return { child, writes };
}

/** A fake spawn that answers hello, so the handshake completes. */
function fakeSpawnWithHello(spawns: FakeChild[]): HelperSpawn {
  return () => {
    const fake = makeFakeChild();
    spawns.push(fake);
    setImmediate(() => {
      const ack = encodeControlFrame({
        type: "hello_ack",
        protocol: 1,
        helperVersion: "0.1.0",
        platform: "test",
        pid: 99999,
      });
      fake.child.stdout.push(ack);
    });
    return fake.child as unknown as ChildProcessWithoutNullStreams;
  };
}

function decodeControlFrames(writes: Buffer[]): ControlMessage[] {
  let view: Uint8Array = new Uint8Array(Buffer.concat(writes));
  const frames: ControlMessage[] = [];
  for (;;) {
    const result = decodeFrame(view);
    if (result.status !== "frame") break;
    view = result.remaining;
    if (result.frame.kind === "control") frames.push(result.frame.message);
  }
  return frames;
}

describe("helper-process (pure parts)", () => {
  it("resolves the binary path inside the plugin directory", () => {
    expect(helperBinaryPath("/plugins/remote-hub")).toBe("/plugins/remote-hub/bin/" + HELPER_BIN_NAME);
  });

  it("parses the --version line", () => {
    expect(parseHelperVersion("remote-hub-helper 0.1.0\n")).toBe("0.1.0");
  });

  it("returns null platform error on this darwin/arm64 machine", () => {
    expect(platformError()).toBeNull();
  });

  // R10: the expected message is a literal, not built with the function under test.
  it("returns helper_missing with a literal expected message", async () => {
    const missing = "/fixed/plugin/root/bin/" + HELPER_BIN_NAME;
    const probe = await probeHelper(missing);
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.error).toEqual({
      code: "helper_missing",
      message:
        "Remote Hub helper binary is missing at /fixed/plugin/root/bin/remote-hub-helper; run 'npm run build:helper' in the plugin directory",
      path: missing,
    });
  });
});

describe("helper-process (lifecycle)", () => {
  // R4: a dead helper is marked, rejects immediately, and a new start sends only hello.
  it("marks a dead helper and starts a fresh one without replaying input", async () => {
    const spawns: FakeChild[] = [];
    const hp = await HelperProcess.spawn("bin", fakeSpawnWithHello(spawns));
    expect(spawns).toHaveLength(1);
    expect(hp.status?.alive).toBe(true);

    spawns[0].child.emit("exit");
    expect(hp.status?.alive).toBe(false);
    await expect(hp.openEcho(80, 24)).rejects.toMatchObject({ code: "helper_exited" });

    const second = await HelperProcess.spawn("bin", fakeSpawnWithHello(spawns));
    expect(spawns).toHaveLength(2);
    expect(decodeControlFrames(spawns[1].writes).map((f) => f.type)).toEqual(["hello"]);
    expect(second.status?.alive).toBe(true);
  });

  // R9: version mismatch surfaces as HelperStartError with code version_mismatch.
  it("surfaces version_mismatch through HelperStartError", async () => {
    const spawn: HelperSpawn = () => {
      const fake = makeFakeChild();
      setImmediate(() => {
        const err = encodeControlFrame({
          type: "error",
          id: null,
          code: "version_mismatch",
          message: "unsupported protocol version",
        });
        fake.child.stdout.push(err);
      });
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    await expect(HelperProcess.spawn("bin", spawn)).rejects.toMatchObject({
      name: "HelperStartError",
      error: { code: "version_mismatch" },
    });
  });

  // R9: an unanswered hello becomes handshake_timeout.
  it("surfaces handshake_timeout when hello is not answered", async () => {
    const spawn: HelperSpawn = () => {
      const fake = makeFakeChild(); // never answers hello
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    await expect(HelperProcess.spawn("bin", spawn, { handshakeTimeoutMs: 50 })).rejects.toMatchObject({
      name: "HelperStartError",
      error: { code: "handshake_timeout" },
    });
  });

  // R8: one streaming decoder per session keeps split multibyte UTF-8 intact.
  it("decodes multibyte UTF-8 split across stream frames", async () => {
    const fake = makeFakeChild();
    const spawn: HelperSpawn = () => {
      setImmediate(() => {
        fake.child.stdout.push(
          encodeControlFrame({
            type: "hello_ack",
            protocol: 1,
            helperVersion: "0.1.0",
            platform: "test",
            pid: 99999,
          }),
        );
      });
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    const hp = await HelperProcess.spawn("bin", spawn);
    const sid = 7;
    fake.child.stdout.push(encodeStreamFrame({ sessionId: sid, seq: 0 }, new Uint8Array([0xc3])));
    fake.child.stdout.push(encodeStreamFrame({ sessionId: sid, seq: 1 }, new Uint8Array([0xa9])));
    await tick();
    expect(hp.drain(sid)).toMatchObject({ output: "é" });
  });
});
