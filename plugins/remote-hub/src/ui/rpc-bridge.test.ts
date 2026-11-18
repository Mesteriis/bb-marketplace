import { describe, expect, it } from "vitest";
import { nonJsonPath } from "../core/json-wire.ts";
import { createConnectBridge } from "./rpc-bridge.ts";

/** An RPC double that refuses what BB's transport refuses: any value that is not strict JSON. */
function strictRpc() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const call = async (method: string, input?: unknown): Promise<unknown> => {
    if (input !== undefined) {
      const bad = nonJsonPath(input, "$input");
      if (bad !== null) throw new Error(`rpc input at ${bad} is not a JSON value`);
    }
    calls.push({ method, input });
    if (method === "session_attach") return { token: "t".repeat(32) };
    if (method === "session_close") return { exitCode: null, signal: null, reason: "killed_by_close" };
    return { ok: true };
  };
  return { call, calls };
}

const HANDLE = { generation: "a".repeat(32), sessionId: 3 };
const PID = "11111111-2222-4333-8444-555555555555";
const FIELDS = {
  name: "n",
  protocol: "ssh",
  group: null,
  tags: [],
  favorite: false,
  color: null,
  host: "h.example.test",
  port: null,
  username: null,
  domain: null,
  authType: "agent",
  identityFile: null,
  credentialRef: null,
  rdpWidth: null,
  rdpHeight: null,
} as never;

describe("the UI -> RPC bridge sends strict JSON only (L1)", () => {
  it("the strict double really refuses an undefined-valued key", async () => {
    const { call } = strictRpc();
    await expect(call("profile_save", { id: undefined, fields: {} })).rejects.toThrow("rpc input at $input.id is not a JSON value");
  });

  it("profile_save of a new profile with an undefined id goes through without the key", async () => {
    const { call, calls } = strictRpc();
    const bridge = createConnectBridge(call, "ws://x");
    await bridge.profiles.save({ id: undefined, fields: FIELDS });
    expect(calls).toEqual([{ method: "profile_save", input: { fields: FIELDS } }]);
    expect(Object.keys(calls[0]?.input as object)).toEqual(["fields"]);
  });

  it("every profile call passes the strict check", async () => {
    const { call, calls } = strictRpc();
    const { profiles } = createConnectBridge(call, "ws://x");
    await profiles.list();
    await profiles.save({ id: PID, fields: FIELDS });
    await profiles.remove(PID);
    await profiles.duplicate(PID);
    await profiles.sessions();
    expect(calls.map((c) => c.method)).toEqual(["profile_list", "profile_save", "profile_delete", "profile_duplicate", "session_list"]);
  });

  it("ssh_open: unset target keys and an absent profile id are left out; a profile id is sent", async () => {
    const { call, calls } = strictRpc();
    const { ssh } = createConnectBridge(call, "ws://x");
    await ssh.onSshOpen({ host: "h.test", user: undefined, port: undefined, identityFile: undefined, extraOptions: [] });
    await ssh.onSshOpen({ host: "h.test", extraOptions: [] }, PID);
    await ssh.onSshOpen({ host: "h.test", extraOptions: [] }, PID, "rh-cred:v1:local:00000000-0000-4000-8000-000000000001");
    expect(calls).toEqual([
      { method: "ssh_open", input: { target: { host: "h.test", extraOptions: [] } } },
      { method: "ssh_open", input: { target: { host: "h.test", extraOptions: [] }, profileId: PID } },
      { method: "ssh_open", input: { target: { host: "h.test", extraOptions: [] }, profileId: PID, credentialRef: "rh-cred:v1:local:00000000-0000-4000-8000-000000000001" } },
    ]);
  });

  it("rdp_open: an undefined domain or profile id never reaches the wire", async () => {
    const { call, calls } = strictRpc();
    const { rdp } = createConnectBridge(call, "ws://x");
    await rdp.onRdpOpen({ host: "h.test", port: 3389, username: "u", password: "pw", domain: undefined } as never, { width: 1280, height: 800 });
    await rdp.onRdpOpen({ host: "h.test", port: 3389, username: "u", password: "pw", domain: "CORP" }, { width: 1920, height: 1080 }, PID);
    expect(calls.map((c) => c.input)).toEqual([
      { target: { host: "h.test", port: 3389, username: "u", password: "pw" }, width: 1280, height: 800 },
      { target: { host: "h.test", port: 3389, username: "u", password: "pw", domain: "CORP" }, width: 1920, height: 1080, profileId: PID },
    ]);
  });

  it("attach, close, decision and screenshot pass the strict check and keep their shapes", async () => {
    const { call, calls } = strictRpc();
    const { ssh, rdp } = createConnectBridge(call, "ws://x/attach");
    expect(await ssh.onAttach(HANDLE)).toEqual({ token: "t".repeat(32), wsUrl: "ws://x/attach" });
    await ssh.onClose(HANDLE);
    await rdp.onDecision(HANDLE, "AA:BB", "once");
    await rdp.onScreenshot(HANDLE);
    expect(calls.map((c) => c.method)).toEqual(["session_attach", "session_close", "rdp_cert_decision", "rdp_screenshot"]);
    expect(calls[2]?.input).toEqual({ generation: HANDLE.generation, sessionId: 3, fingerprint: "AA:BB", accept: "once" });
  });

  it("import calls carry only JSON values: an absent key list and a null path are sent, undefined never", async () => {
    const { call, calls } = strictRpc();
    const { imports } = createConnectBridge(call, "ws://x");
    await imports.add({ kind: "agent", path: null, label: "agent" });
    await imports.apply("s1");
    await imports.apply("s1", ["a"]);
    await imports.set({ id: "s1", enabled: true });
    expect(calls).toEqual([
      { method: "import_source_add", input: { kind: "agent", path: null, label: "agent" } },
      { method: "import_apply", input: { id: "s1" } },
      { method: "import_apply", input: { id: "s1", keys: ["a"] } },
      { method: "import_source_set", input: { id: "s1", enabled: true } },
    ]);
  });
});
