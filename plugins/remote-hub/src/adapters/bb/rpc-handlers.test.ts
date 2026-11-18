import { describe, expect, it, vi } from "vitest";
import { CredentialBook, CredentialError, type CredentialMeta, type CredentialMetaStore, type CredentialVault } from "../../core/credential.ts";
import { ProfileBook, type ProfileStore } from "../../core/profile-book.ts";
import type { Profile, ProfileFields } from "../../core/profile.ts";
import { HelperRequestError } from "./helper-process.ts";
import { emptyReader, memoryImportBook } from "./import-test-support.ts";
import { createRpcHandlers } from "./rpc-handlers.ts";
import type { RemoteHubService } from "./service.ts";

const SECRET = "S3cr3t-HANDLER-1";
const HANDLE = { generation: "a".repeat(32), sessionId: 4 };

class MemoryProfiles implements ProfileStore {
  rows = new Map<string, Profile>();
  all = () => [...this.rows.values()];
  get = (id: string) => this.rows.get(id) ?? null;
  put = (p: Profile) => void this.rows.set(p.id, p);
  remove = (id: string) => this.rows.delete(id);
}
class MemoryMeta implements CredentialMetaStore {
  rows = new Map<string, CredentialMeta>();
  all = () => [...this.rows.values()];
  get = (ref: string) => this.rows.get(ref) ?? null;
  put = (m: CredentialMeta) => void this.rows.set(m.ref, m);
  remove = (ref: string) => this.rows.delete(ref);
}
class MemoryVault implements CredentialVault {
  items = new Map<string, string>();
  async save(ref: string, secret: string) {
    this.items.set(ref, secret);
  }
  async delete(ref: string) {
    if (!this.items.delete(ref)) throw new CredentialError("credential_missing");
  }
  async status(ref: string): Promise<"present" | "missing"> {
    return this.items.has(ref) ? "present" : "missing";
  }
}

const RDP: ProfileFields = {
  name: "win",
  protocol: "rdp",
  group: null,
  tags: [],
  favorite: false,
  color: null,
  host: "win.example.test",
  port: null,
  username: "admin",
  domain: "CORP",
  authType: "password",
  identityFile: null,
  credentialRef: null,
  rdpWidth: null,
  rdpHeight: null,
};

function setup() {
  let n = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const profiles = new ProfileBook({ store: new MemoryProfiles(), now: () => new Date("2026-11-18T10:00:00.000Z"), newId: ids });
  const vault = new MemoryVault();
  const credentials = new CredentialBook({ store: new MemoryMeta(), vault, profiles, now: () => new Date("2026-11-18T10:00:00.000Z"), newId: ids });
  const service = {
    rdpOpen: vi.fn(async () => HANDLE),
    sshOpen: vi.fn(async () => HANDLE),
    rdpCertDecision: vi.fn(async () => undefined),
  };
  const handlers = createRpcHandlers({ service: service as unknown as RemoteHubService, profiles, credentials, imports: memoryImportBook(profiles, credentials) });
  return { profiles, credentials, vault, service, handlers };
}

const rdpInput = (target: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ target: { host: "win.example.test", port: 3389, username: "admin", domain: "CORP", ...target }, width: 1280, height: 800, ...extra }) as never;

describe("rdp_open and a saved credential (R5a: the REAL handler)", () => {
  it("a credential saved for ANOTHER endpoint is refused with credential_target_mismatch and nothing reaches the helper", async () => {
    const { profiles, credentials, handlers, service } = setup();
    const other = profiles.save({ fields: { ...RDP, name: "other", host: "other.example.test" } });
    const { ref } = await credentials.save({ profileId: other.id, secret: SECRET });
    await expect(handlers.rdp_open(rdpInput({ credentialRef: ref }))).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("credential_target_mismatch"),
    });
    expect(service.rdpOpen).not.toHaveBeenCalled();
  });

  it("each part of the endpoint is checked: port, user and domain", async () => {
    const { profiles, credentials, handlers, service } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await credentials.save({ profileId: p.id, secret: SECRET });
    for (const change of [{ port: 3390 }, { username: "root" }, { domain: "OTHER" }, { domain: undefined }]) {
      await expect(handlers.rdp_open(rdpInput({ credentialRef: ref, ...change })), JSON.stringify(change)).rejects.toMatchObject({ message: expect.stringContaining("credential_target_mismatch") });
    }
    expect(service.rdpOpen).not.toHaveBeenCalled();
  });

  it("an unknown reference is credential_unknown", async () => {
    const { handlers, service } = setup();
    await expect(handlers.rdp_open(rdpInput({ credentialRef: "rh-cred:v1:local:00000000-0000-4000-8000-0000000000ff" }))).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("credential_unknown"),
    });
    expect(service.rdpOpen).not.toHaveBeenCalled();
  });

  it("the saved endpoint opens, passing the reference and no password to the service", async () => {
    const { profiles, credentials, handlers, service } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await credentials.save({ profileId: p.id, secret: SECRET });
    await expect(handlers.rdp_open(rdpInput({ credentialRef: ref }, { profileId: p.id }))).resolves.toEqual(HANDLE);
    const [target, , , attributed] = service.rdpOpen.mock.calls[0] as unknown as [Record<string, unknown>, number, number, string];
    expect(target.credentialRef).toBe(ref);
    expect("password" in target).toBe(false);
    expect(attributed).toBe(p.id);
  });

  it("a typed password skips the credential check and a mismatching profile id runs unattributed (P4 at the handler)", async () => {
    const { profiles, handlers, service } = setup();
    const p = profiles.save({ fields: RDP });
    await handlers.rdp_open(rdpInput({ password: SECRET, host: "elsewhere.example.test" }, { profileId: p.id }));
    const call = service.rdpOpen.mock.calls[0] as unknown as [unknown, number, number, string | undefined];
    expect(call[3]).toBeUndefined();
  });

  it("a helper refusal travels with its code in front of the text", async () => {
    const { profiles, credentials, handlers, service } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await credentials.save({ profileId: p.id, secret: SECRET });
    service.rdpOpen.mockRejectedValueOnce(new HelperRequestError("keychain_locked", "the Keychain is locked"));
    await expect(handlers.rdp_open(rdpInput({ credentialRef: ref }))).rejects.toMatchObject({ message: "keychain_locked: the Keychain is locked" });
  });
});

describe("profile_save cannot attach a credential (R5b)", () => {
  it("a foreign credentialRef in the fields is ignored: the saved profile has none", async () => {
    const { profiles, credentials, handlers } = setup();
    const other = profiles.save({ fields: { ...RDP, name: "other", host: "other.example.test" } });
    const { ref } = await credentials.save({ profileId: other.id, secret: SECRET });
    const saved = await handlers.profile_save({ fields: { ...RDP, name: "mine", credentialRef: ref } });
    expect(saved.credentialRef).toBeNull();
    expect(profiles.list().find((p) => p.name === "mine")?.credentialRef).toBeNull();
  });

  it("an update cannot swap in another profile's reference either", async () => {
    const { profiles, credentials, handlers } = setup();
    const mine = profiles.save({ fields: { ...RDP, name: "mine" } });
    const other = profiles.save({ fields: { ...RDP, name: "other", host: "other.example.test" } });
    const { ref } = await credentials.save({ profileId: other.id, secret: SECRET });
    const saved = await handlers.profile_save({ id: mine.id, fields: { ...RDP, name: "mine", credentialRef: ref } });
    expect(saved.credentialRef).toBeNull();
  });
});

const SSH: ProfileFields = { ...RDP, name: "box", protocol: "ssh", host: "box.example.test", port: 2222, username: "root", domain: null };
const sshInput = (target: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ target: { host: "box.example.test", port: 2222, user: "root", extraOptions: [], ...target }, cols: 80, rows: 24, ...extra }) as never;

describe("ssh_open and a saved credential", () => {
  it("a saved password opens with the password method and the reference, never the secret", async () => {
    const { profiles, credentials, handlers, service } = setup();
    const p = profiles.save({ fields: SSH });
    const { ref } = await credentials.save({ profileId: p.id, secret: SECRET });
    await expect(handlers.ssh_open(sshInput({}, { credentialRef: ref, profileId: p.id }))).resolves.toEqual(HANDLE);
    const call = service.sshOpen.mock.calls[0] as unknown as unknown[];
    expect((call[0] as { authMethod?: string }).authMethod).toBe("password");
    expect(call[4]).toEqual({ credentialRef: ref });
    expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("a saved key passphrase opens with the publickey method for exactly that key file", async () => {
    const { profiles, credentials, handlers, service } = setup();
    const p = profiles.save({ fields: { ...SSH, authType: "key", identityFile: "/keys/id_test" } });
    const { ref } = await credentials.save({ profileId: p.id, secret: SECRET });
    await handlers.ssh_open(sshInput({ identityFile: "/keys/id_test" }, { credentialRef: ref }));
    expect((service.sshOpen.mock.calls[0] as unknown as unknown[][])[0]).toMatchObject({ authMethod: "publickey", identityFile: "/keys/id_test" });
    await expect(handlers.ssh_open(sshInput({ identityFile: "/keys/other" }, { credentialRef: ref }))).rejects.toMatchObject({
      message: expect.stringContaining("credential_target_mismatch"),
    });
    await expect(handlers.ssh_open(sshInput({}, { credentialRef: ref }))).rejects.toMatchObject({ message: expect.stringContaining("credential_target_mismatch") });
    expect(service.sshOpen).toHaveBeenCalledTimes(1);
  });

  it("a mixed-case host name is the same host: it authorizes against the lower-case binding", async () => {
    const { profiles, credentials, handlers, service } = setup();
    const p = profiles.save({ fields: { ...SSH, host: "Box.Example.TEST" } });
    const { ref } = await credentials.save({ profileId: p.id, secret: SECRET });
    await handlers.ssh_open(sshInput({ host: "BOX.example.test" }, { credentialRef: ref }));
    expect(service.sshOpen).toHaveBeenCalledTimes(1);
  });

  it("a password saved for another host, port or user is refused and nothing reaches the helper", async () => {
    const { profiles, credentials, handlers, service } = setup();
    const p = profiles.save({ fields: SSH });
    const { ref } = await credentials.save({ profileId: p.id, secret: SECRET });
    for (const change of [{ host: "evil.example.test" }, { port: 22 }, { user: "admin" }]) {
      await expect(handlers.ssh_open(sshInput({ ...change }, { credentialRef: ref })), JSON.stringify(change)).rejects.toMatchObject({
        message: expect.stringContaining("credential_target_mismatch"),
      });
    }
    await expect(handlers.ssh_open(sshInput({}, { credentialRef: "rh-cred:v1:local:00000000-0000-4000-8000-0000000000ff" }))).rejects.toMatchObject({
      message: expect.stringContaining("credential_unknown"),
    });
    expect(service.sshOpen).not.toHaveBeenCalled();
  });

  it("a saved password is refused for a target with no user name (ssh would use the local one)", async () => {
    const { profiles, credentials, handlers, service } = setup();
    const p = profiles.save({ fields: { ...SSH, username: null } });
    const { ref } = await credentials.save({ profileId: p.id, secret: SECRET });
    await expect(handlers.ssh_open(sshInput({ user: undefined }, { credentialRef: ref }))).rejects.toMatchObject({ message: expect.stringContaining("credential_target_mismatch") });
    expect(service.sshOpen).not.toHaveBeenCalled();
  });

  it("without a reference the open is unchanged: no authMethod, no askpass", async () => {
    const { handlers, service } = setup();
    await handlers.ssh_open(sshInput({}));
    const call = service.sshOpen.mock.calls[0] as unknown as unknown[];
    expect((call[0] as { authMethod?: string }).authMethod).toBeUndefined();
    expect(call[4]).toBeUndefined();
  });
});

describe("import RPCs (real handlers, an in-memory book over a fixture reader)", () => {
  const files: Record<string, string> = { "/fixture/config": "Host build\n  HostName build.example.test\n  User ci\nHost jump\n  ProxyJump bastion\n" };
  const reader = { ...emptyReader, readText: (p: string) => (p in files ? { text: files[p] as string, truncated: false } : null) };
  function withImports() {
    const s = setup();
    const imports = memoryImportBook(s.profiles, s.credentials, reader);
    const handlers = createRpcHandlers({ service: s.service as unknown as RemoteHubService, profiles: s.profiles, credentials: s.credentials, imports });
    return { ...s, handlers };
  }

  it("a source starts off; scanning it is forbidden; switching it on allows scan and apply; profile_list then says where profiles came from", async () => {
    const { handlers } = withImports();
    const source = await handlers.import_source_add({ kind: "ssh-config", path: "/fixture/config", label: "fixture" });
    expect(source).toMatchObject({ enabled: false, useSshG: false });
    await expect(handlers.import_scan({ id: source.id })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("source_disabled") });
    await handlers.import_source_set({ id: source.id, enabled: true });
    const scan = (await handlers.import_scan({ id: source.id })) as { scanId: string };
    expect(scan).toMatchObject({ kind: "ssh-config", items: [expect.objectContaining({ key: "build", action: "create" }), expect.objectContaining({ key: "jump", resolved: false })] });
    await expect(handlers.import_apply({ id: source.id })).rejects.toMatchObject({ message: expect.stringContaining("scan_required") });
    expect(await handlers.import_apply({ id: source.id, scanId: scan.scanId })).toMatchObject({ created: 2 });
    const jump = (await handlers.profile_list(null as never)).find((p) => p.name === "jump");
    expect(jump).toMatchObject({ origin: "imported", provenance: { sourceKind: "ssh-config", resolved: false, flags: ["proxy"] } });
    const again = (await handlers.import_scan({ id: source.id })) as { scanId: string };
    expect(await handlers.import_apply({ id: source.id, scanId: again.scanId })).toMatchObject({ created: 0, unchanged: 2 });
  });

  it("a bad path, an unknown source and ssh -G on a disabled source are refused with codes", async () => {
    const { handlers } = withImports();
    await expect(handlers.import_source_add({ kind: "ssh-config", path: "relative", label: "" })).rejects.toMatchObject({ code: "invalid" });
    await expect(handlers.import_scan({ id: "nope" })).rejects.toMatchObject({ code: "not_found" });
    const source = await handlers.import_source_add({ kind: "ssh-config", path: "/fixture/config", label: "" });
    await expect(handlers.import_source_set({ id: source.id, useSshG: true })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("suggestions are strings only: nothing is registered or read until the user adds a source", async () => {
    const { handlers } = withImports();
    const list = await handlers.import_suggestions(null as never);
    expect(list.map((s) => s.kind)).toEqual(["ssh-config", "keys-dir", "hosts", "known-hosts", "agent"]);
    expect(await handlers.import_source_list(null as never)).toEqual([]);
  });
});

describe("agent access RPCs (stage 4a): the owner's page is the only way to change a grant", () => {
  async function withAgents() {
    const { AgentAccessBook } = await import("../../core/agent-access.ts");
    const { AgentAudit } = await import("../../core/agent-audit.ts");
    const { createSqliteAgentAuditStore, createSqliteAgentGrantStore } = await import("./agent-sqlite.ts");
    const { default: Database } = await import("better-sqlite3");
    const { ALL_MIGRATIONS } = await import("./migrations.ts");
    const db = new Database(":memory:");
    for (const statement of ALL_MIGRATIONS) db.exec(statement);
    const s = setup();
    const access = new AgentAccessBook({ store: createSqliteAgentGrantStore(db), profiles: { has: (id) => s.profiles.get(id) !== null }, now: () => new Date("2026-11-18T10:00:00.000Z") });
    const audit = new AgentAudit({ store: createSqliteAgentAuditStore(db), now: () => new Date("2026-11-18T10:00:00.000Z") });
    const handlers = createRpcHandlers({ service: s.service as unknown as RemoteHubService, profiles: s.profiles, credentials: s.credentials, imports: memoryImportBook(s.profiles, s.credentials), agents: { access, audit } });
    return { ...s, handlers, access, audit };
  }

  it("set, list, lower and revoke all; recording commands only sticks at exec", async () => {
    const { handlers, profiles } = await withAgents();
    const p = profiles.save({ fields: RDP });
    expect(await handlers.agent_access_list({})).toEqual([]);
    expect(await handlers.agent_access_set({ profileId: p.id, level: "exec", recordCommands: true })).toEqual({ profileId: p.id, level: "exec", recordCommands: true });
    expect(await handlers.agent_access_list({})).toEqual([{ profileId: p.id, level: "exec", recordCommands: true, updatedAt: "2026-11-18T10:00:00.000Z" }]);
    expect(await handlers.agent_access_set({ profileId: p.id, level: "observe", recordCommands: true })).toEqual({ profileId: p.id, level: "observe", recordCommands: false });
    expect(await handlers.agent_access_revoke_all({})).toEqual({ revoked: 1 });
    expect(await handlers.agent_access_list({})).toEqual([]);
  });

  it("a profile that does not exist cannot be granted", async () => {
    const { handlers } = await withAgents();
    await expect(handlers.agent_access_set({ profileId: "99999999-2222-4333-8444-555555555559", level: "observe", recordCommands: false })).rejects.toMatchObject({ code: "not_found" });
  });

  it("the audit list is newest first and bounded by the limit", async () => {
    const { handlers, audit } = await withAgents();
    for (const tool of ["a", "b", "c"]) audit.begin({ threadId: "thr", projectId: "prj", tool }).finish("ok");
    const rows = await handlers.agent_audit_list({ limit: 2 });
    expect(rows.map((r) => [r.tool, r.outcome, r.threadId])).toEqual([["c", "ok", "thr"], ["b", "ok", "thr"]]);
  });

  const PLUGIN_CALLER = { experimental_caller: { kind: "plugin" as const, pluginId: "other" }, experimental_signal: new AbortController().signal };
  const CLIENT_CALLER = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };

  it("Y2: every owner RPC refuses a caller that is another plugin and serves the app", async () => {
    const { handlers, profiles, access } = await withAgents();
    const p = profiles.save({ fields: RDP });
    const call = handlers as unknown as Record<string, (input: unknown, ctx: unknown) => Promise<unknown>>;
    await expect(call.agent_access_set!({ profileId: p.id, level: "exec", recordCommands: false }, PLUGIN_CALLER)).rejects.toMatchObject({ code: "forbidden" });
    await expect(call.agent_access_revoke_all!({}, PLUGIN_CALLER)).rejects.toMatchObject({ code: "forbidden" });
    await expect(call.profile_list!({}, PLUGIN_CALLER)).rejects.toMatchObject({ code: "forbidden" });
    expect(access.get(p.id).level).toBe("none");
    await expect(call.agent_access_set!({ profileId: p.id, level: "observe", recordCommands: false }, CLIENT_CALLER)).resolves.toMatchObject({ level: "observe" });
  });

  it("Y2: every grant change and revoke is audited as the owner RPC with old and new level", async () => {
    const { handlers, profiles, audit } = await withAgents();
    const p = profiles.save({ fields: RDP });
    await handlers.agent_access_set({ profileId: p.id, level: "exec", recordCommands: false });
    await handlers.agent_access_set({ profileId: p.id, level: "observe", recordCommands: false });
    await handlers.agent_access_revoke_all({});
    const rows = audit.list(10).map((r) => [r.tool, r.threadId, r.profileId, r.detail, r.outcome]);
    expect(rows).toEqual([
      ["access.revoke_all", "owner RPC", null, "removed 1", "ok"],
      ["access.set", "owner RPC", p.id, "observe <- exec", "ok"],
      ["access.set", "owner RPC", p.id, "exec <- none", "ok"],
    ]);
  });

  it("Z8: the owner's certificate decision is audited as theirs, with the choice and not the certificate", async () => {
    const { handlers, audit, service } = await withAgents();
    await handlers.rdp_cert_decision({ ...HANDLE, fingerprint: "AA:BB", accept: "always_trust" } as never);
    expect(service.rdpCertDecision).toHaveBeenCalledTimes(1);
    const rows = audit.list(5).map((r) => [r.tool, r.threadId, r.sessionKey, r.detail, r.outcome]);
    expect(rows).toEqual([["cert.decision", "owner RPC", `${HANDLE.generation}.${HANDLE.sessionId}`, "always_trust", "ok"]]);
    expect(JSON.stringify(audit.list(5))).not.toContain("AA:BB");
  });

  it("without the agent deps the RPCs are not available instead of silently allowing", async () => {
    const { handlers } = setup();
    await expect(handlers.agent_access_list({})).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("session_list marks sessions an agent opened (stage 4c)", () => {
  it("adds the opener thread, and null for everything else", async () => {
    const GEN = "e".repeat(32);
    const sessions = [
      { generation: GEN, sessionId: 1, kind: "ssh", state: "running", exitCode: null, signal: null, reason: null },
      { generation: GEN, sessionId: 2, kind: "ssh", state: "running", exitCode: null, signal: null, reason: null },
    ];
    const profiles = new ProfileBook({ store: new MemoryProfileStoreForOpened(), now: () => new Date(), newId: () => "11111111-2222-4333-8444-555555555551" });
    const handlers = createRpcHandlers({
      service: { sessionList: () => sessions, helperStatus: async () => ({}) } as unknown as RemoteHubService,
      profiles,
      credentials: {} as never,
      imports: {} as never,
      openedBy: (key) => (key === `${GEN}.2` ? "thr_agent" : undefined),
    });
    const listed = (await handlers.session_list(null)) as Array<{ sessionId: number; openedByAgent: string | null }>;
    expect(listed.map((s) => [s.sessionId, s.openedByAgent])).toEqual([[1, null], [2, "thr_agent"]]);
  });
});

class MemoryProfileStoreForOpened {
  all() { return []; }
  get() { return null; }
  put() {}
  remove() { return false; }
  nextOrder() { return 1; }
}
