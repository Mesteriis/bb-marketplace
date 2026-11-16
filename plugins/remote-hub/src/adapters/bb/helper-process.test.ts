import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeControlFrame,
  encodeStreamFrame,
  sessionInputDataSchema,
  type ControlMessage,
} from "../../core/protocol.ts";
import { createRemoteHubService } from "./service.ts";
import { rpcSchemas } from "../../core/rpc.ts";
import {
  HANDSHAKE_TIMEOUT_MS,
  HELPER_BIN_NAME,
  HelperProcess,
  helperBinaryPath,
  parseHelperVersion,
  platformError,
  probeHelper,
  type HelperSpawn,
} from "./helper-process.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const GEN_A = "a".repeat(32);
const GEN_B = "b".repeat(32);

interface FakeChild {
  child: EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => void };
  writes: Buffer[];
  kills: string[];
  stdinEnded: { value: boolean };
}

function makeFakeChild(): FakeChild {
  const writes: Buffer[] = [];
  const kills: string[] = [];
  const stdinEnded = { value: false };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callback();
    },
  });
  (stdin as unknown as { end: () => Writable }).end = () => {
    stdinEnded.value = true;
    return stdin;
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as FakeChild["child"];
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = (signal?: string) => {
    kills.push(signal ?? "");
  };
  return { child, writes, kills, stdinEnded };
}

function helloAck(generation: string): Buffer {
  return Buffer.from(
    encodeControlFrame({
      type: "hello_ack",
      protocol: 1,
      helperVersion: "0.1.0",
      platform: "test",
      pid: 99999,
      generation,
    }),
  );
}

/** A fake spawn that answers hello (with GEN_A), so the handshake completes. */
function fakeSpawnWithHello(spawns: FakeChild[]): HelperSpawn {
  return () => {
    const fake = makeFakeChild();
    spawns.push(fake);
    setImmediate(() => {
      fake.child.stdout.push(helloAck(GEN_A));
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

  // S8: the default handshake timeout is a fixed, exported constant.
  it("exports a 5000 ms handshake timeout", () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(5000);
  });
});

describe("helper-process (lifecycle)", () => {
  // U1: a shared UTF-8 byte-length validator, literals for both boundaries.
  it("accepts 262 144 ASCII bytes and rejects 262 145", () => {
    expect(sessionInputDataSchema.safeParse("x".repeat(262_144)).success).toBe(true);
    expect(sessionInputDataSchema.safeParse("x".repeat(262_145)).success).toBe(false);
  });

  it("accepts 262 144 UTF-8 bytes of é and rejects 262 146", () => {
    expect(sessionInputDataSchema.safeParse("é".repeat(131_072)).success).toBe(true);
    expect(sessionInputDataSchema.safeParse("é".repeat(131_073)).success).toBe(false);
  });

  // A1: lone surrogates are rejected before anything reaches the helper.
  it("rejects lone UTF-16 surrogates", () => {
    expect(sessionInputDataSchema.safeParse("\ud800").success).toBe(false);
    expect(sessionInputDataSchema.safeParse("a\udc00b").success).toBe(false);
  });

  it("rejects a lone surrogate at the adapter without writing to stdin", async () => {
    const fake = makeFakeChild();
    const spawn: HelperSpawn = () => {
      setImmediate(() => fake.child.stdout.push(helloAck(GEN_A)));
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    const hp = await HelperProcess.spawn("bin", spawn);
    await expect(hp.input({ generation: GEN_A, sessionId: 1 }, "\ud800")).rejects.toBeTruthy();
    expect(fake.writes.length).toBe(1); // only hello
  });

  it("rejects 262 145 bytes of session input at the schema", () => {
    const result = rpcSchemas.echo_input.input.safeParse({
      generation: "a".repeat(32),
      sessionId: 1,
      data: "x".repeat(262_145),
    });
    expect(result.success).toBe(false);
  });

  // U1: an oversized input is refused at the adapter without writing to stdin.
  it("refuses oversized input at the adapter without writing to stdin", async () => {
    const fake = makeFakeChild();
    const spawn: HelperSpawn = () => {
      setImmediate(() => fake.child.stdout.push(helloAck(GEN_A)));
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    const hp = await HelperProcess.spawn("bin", spawn);
    await expect(hp.input({ generation: GEN_A, sessionId: 1 }, "é".repeat(131_073))).rejects.toBeTruthy();
    expect(fake.writes.length).toBe(1); // only the hello frame
  });

  // T1: a helper that never answers ping is killed and the next call restarts.
  it(
    "kills a helper that never answers ping and restarts a fresh one",
    async () => {
      const spawns: FakeChild[] = [];
      const service = createRemoteHubService({
        startHelper: () => HelperProcess.spawn("bin", fakeSpawnWithHello(spawns)),
      });
      const status = await service.helperStatus();
      expect(status.alive).toBe(false);
      expect(spawns[0].kills).toContain("SIGTERM");
      expect(spawns[0].stdinEnded.value).toBe(true);
      await service.helperStatus();
      expect(spawns.length).toBe(2);
    },
    10_000,
  );
  // V3: a stale handle/subscriber must never reach a new generation's session.
  it(
    "isolates a stale handle from a new helper generation",
    async () => {
      const spawns: FakeChild[] = [];
      let spawnCount = 0;
      const spawn: HelperSpawn = () => {
        const fake = makeFakeChild();
        spawns.push(fake);
        const generation = spawnCount === 0 ? GEN_A : GEN_B;
        spawnCount += 1;
        setImmediate(() => {
          fake.child.stdout.push(helloAck(generation));
          // The open_echo request is sent in the microtask after the handshake
          // resolves, so answer it in a later macrotask.
          setTimeout(() => {
            fake.child.stdout.push(
              Buffer.from(
                encodeControlFrame({
                  type: "session.opened",
                  id: 1,
                  sessionId: 1,
                  cols: 80,
                  rows: 24,
                  kind: "echo",
                }),
              ),
            );
          }, 0);
        });
        return fake.child as unknown as ChildProcessWithoutNullStreams;
      };
      const service = createRemoteHubService({
        startHelper: () => HelperProcess.spawn("bin", spawn),
      });
      const handleA = await service.echoOpen(80, 24);
      const tokenA = service.sessionAttach(handleA);
      let oldReceived = "";
      const unsubA = service.subscribeSession(handleA, (data) => {
        oldReceived += new TextDecoder().decode(data);
      });

      // The helper dies; a new one starts and reuses session id 1.
      spawns[0].child.emit("exit");
      const handleB = await service.echoOpen(80, 24);

      // B produces output; the stale A subscriber must receive nothing.
      spawns[1].child.stdout.push(
        encodeStreamFrame({ sessionId: handleB.sessionId, seq: 0 }, new TextEncoder().encode("B-output")),
      );
      await tick();
      expect(oldReceived).toBe("");
      unsubA();

      expect(service.consumeAttachToken(tokenA)).toBeNull();
      const writesBefore = spawns[1].writes.length;
      await expect(service.sessionTerminalInput(handleA, new Uint8Array([0x78]))).rejects.toMatchObject({
        code: "session_not_found",
      });
      expect(spawns[1].writes.length).toBe(writesBefore);
      await expect(service.sessionResize(handleA, 100, 30)).rejects.toMatchObject({
        code: "session_not_found",
      });

      const list = service.sessionList();
      const oldInfo = list.find(
        (s) => s.generation === handleA.generation && s.sessionId === handleA.sessionId,
      );
      expect(oldInfo?.state).toBe("closed");
      expect(oldInfo?.reason).toBe("helper_exited");
      const newInfo = list.find(
        (s) => s.generation === handleB.generation && s.sessionId === handleB.sessionId,
      );
      expect(newInfo?.state).toBe("running");
    },
    10_000,
  );

  // V10: ssh output streams bytes straight through and never fills the echo
  // text buffer; only the echo console accumulates decoded text for drain().
  it("does not buffer ssh output in the echo text buffer", async () => {
    const fake = makeFakeChild();
    const spawn: HelperSpawn = () => {
      setImmediate(() => {
        fake.child.stdout.push(helloAck(GEN_A));
        setTimeout(() => {
          fake.child.stdout.push(
            Buffer.from(
              encodeControlFrame({
                type: "session.opened",
                id: 1,
                sessionId: 1,
                cols: 80,
                rows: 24,
                kind: "ssh",
              }),
            ),
          );
        }, 0);
      });
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    const hp = await HelperProcess.spawn("bin", spawn);
    const spec = { program: "/usr/bin/ssh", argv: ["ssh", "-tt", "--", "example.com"], env: { TERM: "xterm" } };
    const sshHandle = await hp.openSsh(spec, 80, 24);
    const big = new Uint8Array(300 * 1024).fill(0x78);
    fake.child.stdout.push(encodeStreamFrame({ sessionId: sshHandle.sessionId, seq: 0 }, big));
    await tick();
    expect(hp.drain(sshHandle.sessionId).output).toBe("");
  });

  it("buffers echo output in the echo text buffer", async () => {
    const fake = makeFakeChild();
    const spawn: HelperSpawn = () => {
      setImmediate(() => {
        fake.child.stdout.push(helloAck(GEN_A));
        setTimeout(() => {
          fake.child.stdout.push(
            Buffer.from(
              encodeControlFrame({
                type: "session.opened",
                id: 1,
                sessionId: 1,
                cols: 80,
                rows: 24,
                kind: "echo",
              }),
            ),
          );
        }, 0);
      });
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    const hp = await HelperProcess.spawn("bin", spawn);
    const echoHandle = await hp.openEcho(80, 24);
    fake.child.stdout.push(
      encodeStreamFrame({ sessionId: echoHandle.sessionId, seq: 0 }, new TextEncoder().encode("echo-token")),
    );
    await tick();
    expect(hp.drain(echoHandle.sessionId).output).toBe("echo-token");
  });

  // The production service must never expose a free-form spawn method
  // (program/argv/env); V4 closed that on the Rust side and this guards the TS
  // interface from reopening it.
  it("production service exposes no free-form open method", async () => {
    const spawns: FakeChild[] = [];
    const service = createRemoteHubService({
      startHelper: () => HelperProcess.spawn("bin", fakeSpawnWithHello(spawns)),
    });
    expect(Object.keys(service)).not.toContain("sshOpenSpec");
    expect("sshOpenSpec" in service).toBe(false);
  });

  // R4 + S7(a): a dead helper is marked, rejects immediately, and a new start
  // sends only hello.
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

  // S7(a): a request that is pending when the child exits rejects with helper_exited.
  it("rejects a pending request when the helper exits", async () => {
    const fake = makeFakeChild();
    const spawn: HelperSpawn = () => {
      setImmediate(() => fake.child.stdout.push(helloAck(GEN_A)));
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    const hp = await HelperProcess.spawn("bin", spawn);
    const pending = hp.openEcho(80, 24); // fake never answers open_echo
    await tick();
    fake.child.emit("exit");
    await expect(pending).rejects.toMatchObject({ code: "helper_exited" });
  });

  // S5: a protocol error kills the child, ends stdin, and stops consuming stdout.
  it("kills the helper and stops consuming stdout after a protocol error", async () => {
    const fake = makeFakeChild();
    const spawn: HelperSpawn = () => {
      setImmediate(() => fake.child.stdout.push(helloAck(GEN_A)));
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    const hp = await HelperProcess.spawn("bin", spawn);
    fake.child.stdout.push(Buffer.from([0, 0, 0, 0])); // invalid frame
    await tick();
    expect(fake.kills).toContain("SIGTERM");
    expect(fake.stdinEnded.value).toBe(true);
    fake.child.stdout.push(encodeStreamFrame({ sessionId: 9, seq: 0 }, new TextEncoder().encode("hi")));
    await tick();
    expect(hp.drain(9).output).toBe("");
  });

  // S6: a session handle from another generation is refused and never written.
  it("refuses a session handle from another helper generation", async () => {
    const fake = makeFakeChild();
    const spawn: HelperSpawn = () => {
      setImmediate(() => fake.child.stdout.push(helloAck(GEN_A)));
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    const hp = await HelperProcess.spawn("bin", spawn);
    await expect(hp.input({ generation: GEN_B, sessionId: 1 }, "x")).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(fake.writes.length).toBe(1); // only hello
  });

  // S7(b): the service drops a dead helper and the next RPC starts a new one
  // whose stdin receives exactly one hello and the new request.
  it("restarts a dead helper with only hello plus the new request", async () => {
    const spawns: FakeChild[] = [];
    const service = createRemoteHubService({
      startHelper: () => HelperProcess.spawn("bin", fakeSpawnWithHello(spawns)),
    });
    const first = service.echoOpen(80, 24); // pending: fake does not answer open_echo
    await tick();
    spawns[0].child.emit("exit");
    await expect(first).rejects.toMatchObject({ code: "helper_exited" });

    const second = service.echoOpen(80, 24);
    await tick();
    expect(spawns).toHaveLength(2);
    expect(decodeControlFrames(spawns[1].writes).map((f) => f.type)).toEqual(["hello", "session.open_echo"]);
  });

  // R9: version mismatch surfaces as HelperStartError with code version_mismatch.
  it("surfaces version_mismatch through HelperStartError", async () => {
    const spawn: HelperSpawn = () => {
      const fake = makeFakeChild();
      setImmediate(() => {
        fake.child.stdout.push(
          encodeControlFrame({
            type: "error",
            id: null,
            code: "version_mismatch",
            message: "unsupported protocol version",
          }),
        );
      });
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    await expect(HelperProcess.spawn("bin", spawn)).rejects.toMatchObject({
      name: "HelperStartError",
      error: { code: "version_mismatch" },
    });
  });

  // S8: a non-version_mismatch handshake error keeps its own code.
  it("passes through non-version_mismatch handshake errors", async () => {
    const spawn: HelperSpawn = () => {
      const fake = makeFakeChild();
      setImmediate(() => {
        fake.child.stdout.push(
          encodeControlFrame({ type: "error", id: null, code: "invalid_frame", message: "bad frame" }),
        );
      });
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    await expect(HelperProcess.spawn("bin", spawn)).rejects.toMatchObject({
      name: "HelperStartError",
      error: { code: "invalid_frame" },
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
        fake.child.stdout.push(helloAck(GEN_A));
        setTimeout(() => {
          fake.child.stdout.push(
            Buffer.from(
              encodeControlFrame({
                type: "session.opened",
                id: 1,
                sessionId: 1,
                cols: 80,
                rows: 24,
                kind: "echo",
              }),
            ),
          );
        }, 0);
      });
      return fake.child as unknown as ChildProcessWithoutNullStreams;
    };
    const hp = await HelperProcess.spawn("bin", spawn);
    const handle = await hp.openEcho(80, 24);
    fake.child.stdout.push(encodeStreamFrame({ sessionId: handle.sessionId, seq: 0 }, new Uint8Array([0xc3])));
    fake.child.stdout.push(encodeStreamFrame({ sessionId: handle.sessionId, seq: 1 }, new Uint8Array([0xa9])));
    await tick();
    expect(hp.drain(handle.sessionId)).toMatchObject({ output: "é" });
  });
});
