// Who may call what, and what a refusal says: the REAL handlers from createRpcHandlers, with ssh replaced by a script.
// (The same rules run against a real sshd in tests/integration/sftp-plugin.test.ts.)
import { describe, expect, it } from "vitest";
import { AgentAudit, type AuditRow, type AuditStore } from "../../core/agent-audit.ts";
import { PluginGrantBook, type PluginGrantRow } from "../../core/plugin-grants.ts";
import type { Profile } from "../../core/profile.ts";
import { rpcSchemas } from "../../core/rpc.ts";
import { SftpChannels, type SftpStream } from "../../core/sftp-channels.ts";
import { SFTP_REFUSALS } from "../../core/sftp-contract.ts";
import type { SftpChannelEnd } from "../../core/sftp-protocol.ts";
import { T } from "../../core/sftp-wire.ts";
import { createRpcHandlers, type RpcCallContext, type RpcHandlers } from "./rpc-handlers.ts";

const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const packet = (body: number[]) => Uint8Array.from([...u32(body.length), ...body]);
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const KEY_PATH = "/Users/owner/.ssh/id_secret_key";
const REF = "rh-cred:v1:host:00000000-0000-4000-8000-00000000abcd";
const profile = (id: string, over: Partial<Profile> = {}): Profile =>
  ({ id, name: "box-" + id.slice(0, 2), protocol: "ssh", group: null, tags: [], favorite: false, color: null, host: "box.test", port: 2222, username: "root", domain: null, authType: "key", identityFile: KEY_PATH, credentialRef: REF, ...over }) as Profile;

const COMMANDER: RpcCallContext = { experimental_caller: { kind: "plugin", pluginId: "makosh-commander" } };
const STRANGER: RpcCallContext = { experimental_caller: { kind: "plugin", pluginId: "some-other-plugin" } };
const PAGE: RpcCallContext = { experimental_caller: { kind: "client" } };

function setup(end: SftpChannelEnd | null = null) {
  const all = [profile(P1), profile(P2, { protocol: "rdp", authType: "password", identityFile: null })];
  const rows = new Map<string, PluginGrantRow>();
  const audited: Array<Omit<AuditRow, "id">> = [];
  const store: AuditStore = { begin: (row) => audited.push({ ...row, outcome: null }) - 1, finish: (id, outcome) => void (audited[id]!.outcome = outcome), collapse: () => false, list: () => [], prune: () => {} };
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  let channels!: SftpChannels;
  const grants = new PluginGrantBook({
    store: { all: () => [...rows.values()], get: (p, f) => rows.get(p + "|" + f) ?? null, put: (r) => void rows.set(r.pluginId + "|" + r.profileId, r), remove: (p, f) => rows.delete(p + "|" + f) },
    now: () => new Date("2026-11-27T10:00:00Z"),
    newId,
    profileExists: (id) => all.some((p) => p.id === id),
    onChange: (c) => void (c.state === "revoked" && channels.revoked(c.pluginId, c.profileId)),
  });
  channels = new SftpChannels({
    grants,
    profile: (id) => {
      const p = all.find((x) => x.id === id);
      return p === undefined ? null : { protocol: p.protocol, host: p.host, agent: false, needsSecret: false };
    },
    agentPresent: () => true,
    newId,
    now: () => new Date("2026-11-27T10:00:00Z"),
    startTimeoutMs: 200,
    transport: {
      async open(_id, sink): Promise<SftpStream> {
        if (end !== null) queueMicrotask(() => sink.closed(end));
        return { generation: "cd".repeat(16), write: (bytes) => (bytes[4] === T.INIT && end === null && queueMicrotask(() => sink.data(packet([T.VERSION, ...u32(3)]))), true), close: () => {} };
      },
    },
  });
  const handlers = createRpcHandlers({
    service: {} as never,
    profiles: { list: () => all, get: (id: string) => all.find((p) => p.id === id) ?? null } as never,
    credentials: {} as never,
    imports: {} as never,
    sftp: { channels, grants, profiles: { list: () => all, get: (id) => all.find((p) => p.id === id) ?? null }, hostKeyKnown: async () => true, audit: new AgentAudit({ store, now: () => new Date("2026-11-27T10:00:00Z") }) },
  });
  return { handlers, grants, audited };
}

const said: string[] = [];
async function call<K extends keyof RpcHandlers>(handlers: RpcHandlers, name: K, input: unknown, ctx?: RpcCallContext): Promise<Awaited<ReturnType<RpcHandlers[K]>>> {
  const parsed = (rpcSchemas[name].input as { parse(v: unknown): unknown }).parse(input);
  try {
    const out = await (handlers[name] as (i: unknown, c?: RpcCallContext) => unknown)(parsed, ctx);
    said.push(JSON.stringify(out));
    (rpcSchemas[name].output as { parse(v: unknown): unknown }).parse(out);
    return out as Awaited<ReturnType<RpcHandlers[K]>>;
  } catch (error) {
    said.push(String((error as Error).message) + JSON.stringify(error));
    throw error;
  }
}
const refusal = async (work: Promise<unknown>): Promise<{ code: string; cls: unknown }> => {
  try {
    await work;
    return { code: "ok", cls: null };
  } catch (error) {
    return { code: String((error as Error).message).split(":")[0] as string, cls: (error as { code?: unknown }).code };
  }
};
const ID = "99999999-9999-4999-8999-999999999999";

describe("SFTP RPC for other plugins", () => {
  it("refuses the owner's page, a shell and a missing caller on every hub_sftp_* call", async () => {
    const { handlers } = setup();
    const calls: Array<[keyof RpcHandlers, unknown]> = [
      ["hub_sftp_profiles", {}],
      ["hub_sftp_request_access", { profileId: P1, level: "read" }],
      ["hub_sftp_grants", {}],
      ["hub_sftp_open", { profileId: P1 }],
      ["hub_sftp_op", { channelId: ID, op: "stat", path: { text: "/" }, follow: true }],
      ["hub_sftp_close", { channelId: ID }],
    ];
    for (const [name, input] of calls) {
      expect(await refusal(call(handlers, name, input, PAGE)), name).toEqual({ code: "caller_not_plugin", cls: "forbidden" });
      expect(await refusal(call(handlers, name, input, undefined)), name).toEqual({ code: "caller_not_plugin", cls: "forbidden" });
      expect(await refusal(call(handlers, name, input, { experimental_caller: { kind: "plugin", pluginId: "" } })), name).toEqual({ code: "caller_not_plugin", cls: "forbidden" });
    }
  });

  it("refuses another plugin on every call that grants, declines or revokes", async () => {
    const { handlers, grants } = setup();
    const calls: Array<[keyof RpcHandlers, unknown]> = [
      ["sftp_access_list", {}],
      ["sftp_access_grant", { pluginId: "makosh-commander", profileId: P1, level: "write" }],
      ["sftp_access_decline", { requestId: ID }],
      ["sftp_access_revoke", { pluginId: "makosh-commander", profileId: P1 }],
      ["sftp_access_revoke_all", {}],
    ];
    for (const [name, input] of calls) expect((await refusal(call(handlers, name, input, COMMANDER))).cls, name).toBe("forbidden");
    expect(grants.granted()).toEqual([]);
  });

  it("acts for the plugin the host reports: an input cannot name another one", async () => {
    const { handlers } = setup();
    // The schemas are strict: there is no field to say who is asking.
    expect(rpcSchemas.hub_sftp_request_access.input.safeParse({ profileId: P1, level: "write", pluginId: "makosh-commander" }).success).toBe(false);
    expect(rpcSchemas.hub_sftp_open.input.safeParse({ profileId: P1, pluginId: "makosh-commander" }).success).toBe(false);
    await call(handlers, "hub_sftp_request_access", { profileId: P1, level: "write" }, STRANGER);
    const page = await call(handlers, "sftp_access_list", {}, PAGE);
    expect(page.requests.map((r) => r.pluginId)).toEqual(["some-other-plugin"]);
    await call(handlers, "sftp_access_grant", { pluginId: "makosh-commander", profileId: P1, level: "write" }, PAGE);
    expect((await refusal(call(handlers, "hub_sftp_open", { profileId: P1 }, STRANGER))).code).toBe("consent_required");
    const { channelId } = await call(handlers, "hub_sftp_open", { profileId: P1 }, COMMANDER);
    expect((await refusal(call(handlers, "hub_sftp_op", { channelId, op: "realpath", path: { text: "." } }, STRANGER))).code).toBe("channel_closed");
    expect(await call(handlers, "hub_sftp_close", { channelId }, STRANGER)).toEqual({ closed: false });
    expect(await call(handlers, "hub_sftp_close", { channelId }, COMMANDER)).toEqual({ closed: true });
  });

  it("lists only SSH connections, without a key path or a credential reference", async () => {
    const { handlers } = setup();
    const { profiles } = await call(handlers, "hub_sftp_profiles", {}, COMMANDER);
    expect(profiles).toEqual([{ id: P1, name: "box-11", group: null, host: "box.test", port: 2222, user: "root", authType: "key", consent: "none", level: null, hostKey: "trusted", needsConfig: false }]);
    expect((await refusal(call(handlers, "hub_sftp_request_access", { profileId: P2, level: "read" }, COMMANDER))).code).toBe("profile_not_sftp");
    expect((await refusal(call(handlers, "hub_sftp_request_access", { profileId: ID, level: "read" }, COMMANDER))).code).toBe("profile_not_found");
  });

  it("a refusal is a stable code of its class and a fixed sentence, whatever ssh wrote", async () => {
    const { handlers, audited } = setup({ reason: "exited", exitCode: 255, refused: null, stderr: `Load key "${KEY_PATH}": bad permissions\nroot@box.test: Permission denied (publickey).\n` });
    await call(handlers, "sftp_access_grant", { pluginId: "makosh-commander", profileId: P1, level: "write" }, PAGE);
    let thrown: Error | null = null;
    try {
      await call(handlers, "hub_sftp_open", { profileId: P1 }, COMMANDER);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe("auth_failed: the server refused the sign-in");
    expect((thrown as unknown as { code: string }).code).toBe(SFTP_REFUSALS.auth_failed);
    expect(audited.map((r) => [r.threadId, r.tool, r.outcome])).toEqual([
      ["owner RPC", "sftp.grant", "ok"],
      ["plugin:makosh-commander", "sftp.open", "auth_failed"],
    ]);
  });

  it("records what changed something on a server by operation and outcome, never by path", async () => {
    const { handlers, audited } = setup();
    await call(handlers, "sftp_access_grant", { pluginId: "makosh-commander", profileId: P1, level: "read" }, PAGE);
    const { channelId } = await call(handlers, "hub_sftp_open", { profileId: P1 }, COMMANDER);
    expect((await refusal(call(handlers, "hub_sftp_op", { channelId, op: "mkdir", path: { text: "/srv/private-name" } }, COMMANDER))).code).toBe("consent_required");
    expect(await call(handlers, "sftp_access_revoke", { pluginId: "makosh-commander", profileId: P1 }, PAGE)).toEqual({ revoked: true, channelsClosed: 1 });
    expect((await refusal(call(handlers, "hub_sftp_op", { channelId, op: "realpath", path: { text: "." } }, COMMANDER))).code).toBe("consent_revoked");
    expect(audited.map((r) => [r.tool, r.outcome])).toEqual([["sftp.grant", "ok"], ["sftp.open", "ok"], ["sftp.mkdir", "consent_required"], ["sftp.revoke", "ok"]]);
    expect(JSON.stringify(audited)).not.toContain("private-name");
  });

  it("nothing that was answered in this file holds the key path or the credential reference", () => {
    expect(said.length).toBeGreaterThan(30);
    const everything = said.join("\n");
    expect(everything.includes(KEY_PATH)).toBe(false);
    expect(everything.includes("id_secret_key")).toBe(false);
    expect(everything.includes("rh-cred:")).toBe(false);
  });
});
