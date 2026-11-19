// The service's remote-command paths over a scripted helper: what is sent (a -T argv with the command as one word and the
// saved-secret askpass), how answers are decoded, and that a run of another helper generation is refused.
import { describe, expect, it, vi } from "vitest";
import type { ExecFinishedMessage, ExecStateMessage } from "../../core/exec-protocol.ts";
import type { HelperProcess } from "./helper-process.ts";
import { createRemoteHubService } from "./service.ts";

const GEN = "c".repeat(32);

function setup() {
  const finished: Array<(e: ExecFinishedMessage) => void> = [];
  const sent: Array<{ spec: { program: string; argv: string[]; env: Record<string, string> }; askpass: { credentialRef: string }; timeoutMs: number; maxBytes: number }> = [];
  const state = (over: Partial<ExecStateMessage> = {}): ExecStateMessage => ({
    type: "exec.state", id: 1, execId: 7, running: false, exitCode: 0, signal: null, reason: "exited", refused: null, elapsedMs: 12,
    stdout: { start: 0, end: 5, data: Buffer.from("hello").toString("base64"), total: 5, truncated: false },
    stderr: { start: 0, end: 0, data: "", total: 0, truncated: false }, ...over,
  });
  const helper = {
    currentGeneration: GEN,
    execRun: vi.fn(async (spec, askpass, timeoutMs, maxBytes) => (sent.push({ spec, askpass, timeoutMs, maxBytes }), 7)),
    execRead: vi.fn(async () => state()),
    execCancel: vi.fn(async () => state({ running: true, exitCode: null, reason: null })),
    execForget: vi.fn(async () => undefined),
    onExecFinished: (cb: (e: ExecFinishedMessage) => void) => void finished.push(cb),
    onSessionClosed: () => {}, onExit: () => {}, onSessionOutput: () => {}, onSshAskpass: () => {}, onPveEvent: () => {}, onVncData: () => {}, onRdpEvent: () => {}, onRdpUpdate: () => {},
    stop: () => {},
  };
  const service = createRemoteHubService({ startHelper: async () => helper as unknown as HelperProcess, env: { PATH: "/usr/bin" } });
  return { service, helper, sent, finished };
}

describe("service exec", () => {
  it("starts a run with the command as one argv word, the saved-secret askpass and the limits, and returns a handle of this generation", async () => {
    const { service, sent } = setup();
    const handle = await service.execRun({ host: "Box.test", user: "ops", authMethod: "password", extraOptions: [] }, "uname -a; id", "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a", 30_000, 65_536);
    expect(handle).toEqual({ generation: GEN, execId: 7 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.spec.argv.slice(0, 2)).toEqual(["ssh", "-T"]);
    expect(sent[0]!.spec.argv.at(-1)).toBe("uname -a; id");
    expect(sent[0]!.spec.argv.at(-3)).toBe("--");
    expect(sent[0]).toMatchObject({ askpass: { credentialRef: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a" }, timeoutMs: 30_000, maxBytes: 65_536 });
  });

  it("decodes the helper's base64 into bytes", async () => {
    const { service } = setup();
    const handle = await service.execRun({ host: "box.test", authMethod: "password", user: "u", extraOptions: [] }, "id", "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a", 1000, 1024);
    const snap = await service.execRead(handle, 0, 0, 100);
    expect(new TextDecoder().decode(snap.stdout.data)).toBe("hello");
    expect(snap).toMatchObject({ running: false, exitCode: 0, reason: "exited", refused: null });
    expect((await service.execCancel(handle)).running).toBe(true);
    await service.execForget(handle);
  });

  it("refuses a handle from another helper generation without calling the helper", async () => {
    const { service, helper } = setup();
    await expect(service.execRead({ generation: "d".repeat(32), execId: 7 }, 0, 0, 10)).rejects.toThrow(/different helper generation/);
    expect(helper.execRead).not.toHaveBeenCalled();
  });

  it("tells its listeners when a run ends, and a listener that throws does not stop the others", async () => {
    const { service, finished } = setup();
    const seen: unknown[] = [];
    service.onExecFinished(() => {
      throw new Error("x");
    });
    const off = service.onExecFinished((e) => seen.push(e));
    await service.execRun({ host: "box.test", authMethod: "password", user: "u", extraOptions: [] }, "id", "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a", 1000, 1024);
    finished[0]!({ type: "exec.finished", execId: 7, exitCode: 2, signal: null, reason: "exited", refused: null });
    expect(seen).toEqual([{ handle: { generation: GEN, execId: 7 }, exitCode: 2, signal: null, reason: "exited", refused: null }]);
    off();
    finished[0]!({ type: "exec.finished", execId: 7, exitCode: 0, signal: null, reason: "exited", refused: null });
    expect(seen).toHaveLength(1);
  });
});
