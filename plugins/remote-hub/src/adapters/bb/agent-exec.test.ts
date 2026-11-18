import { describe, expect, it, vi } from "vitest";
import { AgentFeed } from "../../core/agent-feed.ts";
import { CredentialError } from "../../core/credential.ts";
import type { Profile } from "../../core/profile.ts";
import { agentExecPorts, EXEC_KEEP_BYTES } from "./agent-exec.ts";
import type { ExecHandle, ExecSnapshot, RemoteHubService } from "./service.ts";

const GEN = "b".repeat(32);
const P = "11111111-2222-4333-8444-555555555551";
const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
const SESSION = `${GEN}.1`;
const profile = (over: Partial<Profile> = {}): Profile => ({ id: P, protocol: "ssh", host: "Box.test", port: 2222, username: "ops", authType: "password", identityFile: null, credentialRef: REF, ...over }) as Profile;
const enc = (s: string) => new TextEncoder().encode(s);
const chunk = (text: string, start = 0, total = start + enc(text).length) => ({ start, end: start + enc(text).length, data: enc(text), total, truncated: false });
const snap = (over: Partial<ExecSnapshot> = {}): ExecSnapshot => ({ running: true, exitCode: null, signal: null, reason: null, refused: null, elapsedMs: 1, stdout: chunk(""), stderr: chunk(""), ...over });

function setup(p: Profile | null = profile()) {
  const finished: Array<(e: { handle: ExecHandle; exitCode: number | null; signal: number | null; reason: string; refused: string | null }) => void> = [];
  let reads: ExecSnapshot[] = [snap()];
  const service = {
    execRun: vi.fn(async () => ({ generation: GEN, execId: 9 })),
    execRead: vi.fn(async () => (reads.length > 1 ? reads.shift()! : reads[0]!)),
    execCancel: vi.fn(async () => snap()),
    execForget: vi.fn(async () => undefined),
    onExecFinished: (cb: (typeof finished)[number]) => (finished.push(cb), () => undefined),
  };
  const credentials = { authorizeSsh: vi.fn(() => "password" as const) };
  const feed = new AgentFeed();
  const seen: unknown[] = [];
  feed.subscribe(SESSION, (e) => seen.push(e));
  const ports = agentExecPorts({ service: service as unknown as RemoteHubService, profiles: { get: () => p }, credentials, feed, pollMs: 5 });
  return { ports, service, credentials, seen, finished, setReads: (r: ExecSnapshot[]) => void (reads = r) };
}

describe("agent exec ports", () => {
  it("starts the command with the profile's saved credential, the lower-cased host, the authorised method and the bound limits", async () => {
    const t = setup();
    const run = await t.ports.start({ sessionKey: SESSION, profileId: P, command: "id", timeoutMs: 30_000 });
    expect(run.runKey).toBe(`${GEN}.9`);
    expect(t.credentials.authorizeSsh).toHaveBeenCalledWith(REF, { protocol: "ssh", host: "box.test", port: 2222, user: "ops", domain: null }, undefined);
    expect(t.service.execRun).toHaveBeenCalledWith({ host: "Box.test", user: "ops", port: 2222, extraOptions: [], authMethod: "password" }, "id", REF, 30_000, EXEC_KEEP_BYTES);
  });

  it("a profile that is gone, is not SSH or has no saved credential cannot run anything, with a closed-list code", async () => {
    for (const [p, code] of [[null, "needs_saved_credential"], [profile({ protocol: "rdp" }), "needs_saved_credential"], [profile({ credentialRef: null }), "needs_saved_credential"]] as const) {
      const t = setup(p);
      await expect(t.ports.start({ sessionKey: SESSION, profileId: P, command: "id", timeoutMs: 1000 })).rejects.toMatchObject({ code });
      expect(t.service.execRun).not.toHaveBeenCalled();
    }
  });

  it("a saved credential for another endpoint is refused before anything is started", async () => {
    const t = setup();
    t.credentials.authorizeSsh.mockImplementation(() => {
      throw new CredentialError("credential_target_mismatch");
    });
    await expect(t.ports.start({ sessionKey: SESSION, profileId: P, command: "id", timeoutMs: 1000 })).rejects.toMatchObject({ code: "credential_target_mismatch" });
    expect(t.service.execRun).not.toHaveBeenCalled();
  });

  it("the helper's own error code passes through for the tools' closed list (they never show its text)", async () => {
    const t = setup();
    t.service.execRun.mockRejectedValueOnce(Object.assign(new Error("long internal text"), { code: "host_key_unknown" }));
    await expect(t.ports.start({ sessionKey: SESSION, profileId: P, command: "id", timeoutMs: 1000 })).rejects.toMatchObject({ code: "host_key_unknown" });
  });

  it("streams what the command prints to the session's live view as it happens, then its end, without storing it", async () => {
    const t = setup();
    t.setReads([snap({ stdout: chunk("line one\n") }), snap({ stdout: chunk("line two\n", 9, 18), stderr: chunk("oops\n") }), snap({ running: false, exitCode: 4, reason: "exited", stdout: chunk("", 18, 18), stderr: chunk("", 5, 5) })]);
    await t.ports.start({ sessionKey: SESSION, profileId: P, command: "id", timeoutMs: 1000 });
    await vi.waitFor(() => expect(t.seen.some((e) => (e as { phase?: string }).phase === "finished")).toBe(true));
    const out = (t.seen as Array<{ kind: string; phase: string; stream?: string; text: string; exitCode?: number | null; reason?: string }>).filter((e) => e.phase === "output");
    expect(out.map((e) => [e.stream, e.text])).toEqual([["stdout", "line one\n"], ["stdout", "line two\n"], ["stderr", "oops\n"]]);
    expect(t.seen.at(-1)).toMatchObject({ kind: "exec", phase: "finished", exitCode: 4, reason: "exited" });
  });

  it("the live text has its control sequences removed, like terminal text", async () => {
    const t = setup();
    t.setReads([snap({ stdout: chunk("a\u001b[31mred\u001b[0m\u0007b\n") }), snap({ running: false, exitCode: 0, reason: "exited" })]);
    await t.ports.start({ sessionKey: SESSION, profileId: P, command: "id", timeoutMs: 1000 });
    await vi.waitFor(() => expect(t.seen.some((e) => (e as { phase?: string }).phase === "finished")).toBe(true));
    expect((t.seen as Array<{ phase: string; text: string }>).find((e) => e.phase === "output")!.text).toBe("aredb\n");
  });

  it("tells the tools when a run ended, whether the helper said so or the poll saw it, and stops polling then", async () => {
    const t = setup();
    const ended: string[] = [];
    t.ports.onFinished((k) => ended.push(k));
    await t.ports.start({ sessionKey: SESSION, profileId: P, command: "id", timeoutMs: 1000 });
    t.finished[0]!({ handle: { generation: GEN, execId: 9 }, exitCode: 0, signal: null, reason: "exited", refused: null });
    expect(ended).toEqual([`${GEN}.9`]);
    const calls = t.service.execRead.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(t.service.execRead.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });

  it("read, cancel and forget address the run by its key", async () => {
    const t = setup();
    await t.ports.read(`${GEN}.9`, 5, 6, 100);
    expect(t.service.execRead).toHaveBeenLastCalledWith({ generation: GEN, execId: 9 }, 5, 6, 100);
    await t.ports.cancel(`${GEN}.9`);
    expect(t.service.execCancel).toHaveBeenCalledWith({ generation: GEN, execId: 9 });
    await t.ports.forget(`${GEN}.9`);
    expect(t.service.execForget).toHaveBeenCalledWith({ generation: GEN, execId: 9 });
    await expect(t.ports.read("not-a-key", 0, 0, 1)).rejects.toThrow();
  });
});
