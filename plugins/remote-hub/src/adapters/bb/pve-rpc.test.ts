import { describe, expect, it } from "vitest";
import { AgentAudit, type AuditRow, type AuditStore } from "../../core/agent-audit.ts";
import { CredentialBook, CredentialError, type CredentialMeta, type CredentialMetaStore, type CredentialVault } from "../../core/credential.ts";
import { ProfileBook, type ProfileStore } from "../../core/profile-book.ts";
import type { Profile, ProfileFields } from "../../core/profile.ts";
import type { PvePlan, PveSteps } from "../../core/pve-protocol.ts";
import type { PveAnswer, PveProvisionAnswer } from "../../core/pve-targets.ts";
import { HelperRequestError } from "./helper-process.ts";
import { createPveRpc, PveRpcError } from "./pve-rpc.ts";
import type { PveGuestLinkStore } from "./pve-sqlite.ts";

const FP = "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E";
const OTHER_FP = "36:28:12:20:8A:0A:3D:00:92:3E:DB:13:8A:D2:BF:2F:AF:AE:CC:82:6B:4E:BD:24:81:4E:6A:25:F0:35:CD:99";
const ADMIN_PW = "Admin-PW-77x";
const DIGEST = "a".repeat(64);
const USER = "remotehub@pve";
const REF1 = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01";

class MemProfiles implements ProfileStore {
  rows = new Map<string, Profile>();
  all = () => [...this.rows.values()];
  get = (id: string) => this.rows.get(id) ?? null;
  put = (p: Profile) => void this.rows.set(p.id, p);
  remove = (id: string) => this.rows.delete(id);
}
class MemMeta implements CredentialMetaStore {
  rows = new Map<string, CredentialMeta>();
  all = () => [...this.rows.values()];
  get = (r: string) => this.rows.get(r) ?? null;
  put = (m: CredentialMeta) => void this.rows.set(m.ref, m);
  remove = (r: string) => this.rows.delete(r);
}
class MemLinks implements PveGuestLinkStore {
  rows = new Map<string, number | string>();
  forProfile = (id: string) => new Map([...this.rows].filter(([k]) => k.startsWith(id + "|")).map(([k, v]) => [Number(k.split("|")[1]), String(v)]));
  set = (id: string, vmid: number, link: string) => void this.rows.set(`${id}|${vmid}`, link);
  clear = (id: string, vmid: number) => this.rows.delete(`${id}|${vmid}`);
  dropProfile = (id: string) => {
    for (const [k, v] of [...this.rows]) if (k.startsWith(id + "|") || v === id) this.rows.delete(k);
  };
}

const PLAN: PvePlan = { role: "create", user: "create", acl: "create", userId: USER, rolePrivs: null, extras: { acl: [], groups: [], tokens: [] }, digest: DIGEST };
const DONE: PveSteps = { role: "done", user: "done", acl: "done" };

type ProvisionArg = { dryRun: boolean; userId: string; planDigest?: string; replaceRole?: boolean; save?: Array<{ ref: string; bind: unknown }> };

function world() {
  const profiles = new MemProfiles();
  let tick = 0;
  let n = 0;
  const book = new ProfileBook({
    store: profiles,
    // every save gets a new revision, as the real clock does
    now: () => new Date(Date.UTC(2026, 10, 18, 10, 0, ++tick)),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  const meta = new MemMeta();
  const items = new Map<string, string>();
  const vault: CredentialVault = {
    async save(ref, secret) {
      items.set(ref, secret);
    },
    async delete(ref) {
      if (!items.delete(ref)) throw new CredentialError("credential_missing");
    },
    async status(ref) {
      return items.has(ref) ? "present" : "missing";
    },
  };
  const credentials = new CredentialBook({ store: meta, vault, profiles: book, now: () => new Date("2026-11-18T10:00:00Z"), newId: () => `0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b${String(++n).padStart(2, "0")}` });
  const calls: Array<{ kind: string; arg: unknown }> = [];
  const state = {
    openError: null as Error | null,
    skipSave: false,
    targets: (async () => ({ ok: true, version: "9.0.3", nodes: [], guests: [{ vmid: 100, name: "db", kind: "qemu", node: "pve1", status: "running", template: false }] })) as () => Promise<PveAnswer>,
    provision: (async (arg: ProvisionArg): Promise<PveProvisionAnswer> => (arg.dryRun ? { ok: true, kind: "plan", plan: PLAN } : { ok: true, kind: "applied", steps: DONE })) as (arg: ProvisionArg) => Promise<PveProvisionAnswer>,
  };
  const service = {
    pve: {
      targets: async (connect: unknown) => {
        calls.push({ kind: "targets", arg: connect });
        return await state.targets();
      },
      provision: async (arg: ProvisionArg) => {
        calls.push({ kind: "provision", arg });
        const answer = await state.provision(arg);
        // The helper saves the new password in the Keychain as soon as the user step is done.
        const userDone = answer.ok ? answer.kind === "applied" : answer.steps?.user === "done";
        if (userDone && !arg.dryRun && !state.skipSave) for (const s of arg.save ?? []) items.set(s.ref, "helper-saved-secret");
        return answer;
      },
    },
    credentialVault: vault,
    pveOpen: async (args: Record<string, unknown>) => {
      calls.push({ kind: "pveOpen", arg: args });
      if (state.openError !== null) throw state.openError;
      return { handle: { generation: "e".repeat(32), sessionId: 7 }, kind: (args.target as { kind: string }).kind === "qemu" ? ("vnc" as const) : ("pve" as const) };
    },
  };
  const links = new MemLinks();
  const rows: AuditRow[] = [];
  let rid = 0;
  const store: AuditStore = { begin: (r) => (rows.push({ ...r, id: ++rid, outcome: null }), rid), finish: (id, o) => void (rows.find((r) => r.id === id)!.outcome = o), collapse: () => false, list: (k) => [...rows].reverse().slice(0, k), prune: () => {} };
  const audit = new AgentAudit({ store, now: () => new Date("2026-11-18T10:00:00Z") });
  const rpc = createPveRpc({ service: service as never, profiles: book, credentials, links, newId: () => "0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b77", now: () => new Date("2026-11-18T10:00:00Z"), audit });
  return { rpc, book, meta, items, calls, state, links, rows, credentials };
}

const PVE: ProfileFields = {
  name: "lab", protocol: "pve", group: null, tags: [], favorite: false, color: null, host: "pve.test", port: null, username: USER, domain: null,
  authType: "password", identityFile: null, credentialRef: null, rdpWidth: null, rdpHeight: null, pveTrust: null,
};
const SSH: ProfileFields = { ...PVE, name: "guest ssh", protocol: "ssh", username: "root", authType: "agent", port: null };

function withRef(w: ReturnType<typeof world>, fields: Partial<ProfileFields> = {}, ref = REF1): Profile {
  const p = w.book.save({ fields: { ...PVE, ...fields } });
  w.items.set(ref, "old-secret");
  w.book.link(p.id, ref);
  return w.book.get(p.id)!;
}

describe("discovery", () => {
  it("asks with the saved credential's reference, never a secret, and the profile's trust", async () => {
    const w = world();
    const p = w.book.save({ fields: { ...PVE, pveTrust: { mode: "pin", fingerprint: FP } } });
    w.items.set(REF1, "x");
    w.book.link(p.id, REF1);
    const [view] = await w.rpc.targets({ refresh: true });
    expect(view?.outcome).toBe("ok");
    expect(w.calls[0]?.arg).toEqual({ host: "pve.test", port: 8006, authMode: "ticket", user: USER, credentialRef: REF1, trust: { mode: "pin", fingerprint: FP } });
  });

  it("a connection without a credential is no_credential and is not asked; other protocols are not listed", async () => {
    const w = world();
    w.book.save({ fields: PVE });
    w.book.save({ fields: SSH });
    expect((await w.rpc.targets({ refresh: true })).map((v) => v.outcome)).toEqual(["no_credential"]);
    expect(w.calls).toEqual([]);
  });

  it("an API token connection signs in as a token", async () => {
    const w = world();
    withRef(w, { authType: "token", username: "remotehub@pve!rh" });
    await w.rpc.targets({ refresh: true });
    expect((w.calls[0]?.arg as { authMode: string }).authMode).toBe("token");
  });
});

describe("pinning a certificate (E5)", () => {
  async function refused() {
    const w = world();
    const p = withRef(w);
    w.state.targets = async () => ({ ok: false, code: "tls_untrusted", message: "", fingerprint: FP });
    const [view] = await w.rpc.targets({ refresh: true });
    expect(view?.outcome).toBe("tls_untrusted");
    return { w, p };
  }

  it("trusts exactly the certificate the server presented, for the connection as it is now", async () => {
    const { w, p } = await refused();
    w.rpc.pinTrust(p.id, FP);
    expect(w.book.get(p.id)?.pveTrust).toEqual({ mode: "pin", fingerprint: FP });
  });

  it("refuses a fingerprint the server did not present, and a profile that is not Proxmox", async () => {
    const { w, p } = await refused();
    expect(() => w.rpc.pinTrust(p.id, OTHER_FP)).toThrow(PveRpcError);
    expect(w.book.get(p.id)?.pveTrust ?? null).toBeNull();
    expect(() => w.rpc.pinTrust(w.book.save({ fields: SSH }).id, FP)).toThrow(/no such Proxmox connection/);
  });

  it("editing the host or port discards the refusal: the old certificate can no longer be pinned under that profile", async () => {
    const { w, p } = await refused();
    w.book.save({ id: p.id, fields: { ...profileFields(w.book.get(p.id)!), host: "other.pve.test" } });
    expect(() => w.rpc.pinTrust(p.id, FP)).toThrow(/not the certificate/);
    expect(w.book.get(p.id)?.pveTrust ?? null).toBeNull();
  });

  it("any edit of the profile (a new revision) discards the refusal too", async () => {
    const { w, p } = await refused();
    w.book.save({ id: p.id, fields: { ...profileFields(w.book.get(p.id)!), name: "renamed" } });
    expect(() => w.rpc.pinTrust(p.id, FP)).toThrow(PveRpcError);
  });

  it("a discovery answer that arrives after the connection was edited is dropped, not shown or offered for a pin", async () => {
    const w = world();
    const p = withRef(w);
    let release: (a: PveAnswer) => void = () => {};
    w.state.targets = () => new Promise<PveAnswer>((r) => (release = r));
    const pending = w.rpc.targets({ refresh: true });
    await Promise.resolve();
    w.book.save({ id: p.id, fields: { ...profileFields(w.book.get(p.id)!), host: "moved.pve.test" } });
    release({ ok: false, code: "tls_untrusted", message: "", fingerprint: FP });
    const [view] = await pending;
    expect(view?.outcome).toBe("error");
    expect(view?.fingerprint).toBeNull();
    expect(() => w.rpc.pinTrust(p.id, FP)).toThrow(PveRpcError);
  });

  it("forgetting is not undone by an answer that was already on its way", async () => {
    const w = world();
    const p = withRef(w);
    let release: (a: PveAnswer) => void = () => {};
    w.state.targets = () => new Promise<PveAnswer>((r) => (release = r));
    const pending = w.rpc.targets({ refresh: true });
    await Promise.resolve();
    w.rpc.discovery.forget(p.id);
    release({ ok: false, code: "tls_untrusted", message: "", fingerprint: FP });
    await pending;
    expect(w.rpc.discovery.lastPresented(p.id)).toBeNull();
    expect(() => w.rpc.pinTrust(p.id, FP)).toThrow(PveRpcError);
  });

  it("the generic profile save stores a pin only if it is the stored one or the one the last refusal showed", async () => {
    const { w, p } = await refused();
    const fields = (pveTrust: ProfileFields["pveTrust"], over: Partial<ProfileFields> = {}) => ({ id: p.id, fields: { ...profileFields(w.book.get(p.id)!), pveTrust, ...over } });
    expect(() => w.rpc.checkProfileSave(fields({ mode: "pin", fingerprint: OTHER_FP }))).toThrow(PveRpcError);
    expect(() => w.rpc.checkProfileSave({ fields: { ...PVE, pveTrust: { mode: "pin", fingerprint: FP } } })).toThrow(PveRpcError);
    expect(() => w.rpc.checkProfileSave(fields({ mode: "pin", fingerprint: FP }, { host: "elsewhere.test" }))).toThrow(PveRpcError);
    expect(() => w.rpc.checkProfileSave(fields({ mode: "pin", fingerprint: FP }))).not.toThrow();
    expect(() => w.rpc.checkProfileSave(fields({ mode: "system" }))).not.toThrow();
    expect(() => w.rpc.checkProfileSave(fields(null))).not.toThrow();
    // Once stored, the same pin on the same endpoint passes without a refusal (an unrelated edit such as a rename).
    w.rpc.pinTrust(p.id, FP);
    expect(() => w.rpc.checkProfileSave(fields({ mode: "pin", fingerprint: FP }, { name: "renamed" }))).not.toThrow();
    expect(() => w.rpc.checkProfileSave(fields({ mode: "pin", fingerprint: OTHER_FP }))).toThrow(PveRpcError);
  });
});

function profileFields(p: Profile): ProfileFields {
  const { id: _i, executionHostId: _e, origin: _o, createdAt: _c, updatedAt: _u, lastOpenedAt: _l, recentErrors: _r, provenance: _p, needsConfig: _n, ...fields } = p;
  return fields as ProfileFields;
}

describe("guest links", () => {
  it("link a guest to a saved SSH or RDP profile only, per environment", () => {
    const w = world();
    const a = w.book.save({ fields: PVE });
    const b = w.book.save({ fields: { ...PVE, name: "other" } });
    const ssh = w.book.save({ fields: SSH });
    w.rpc.linkGuest(a.id, 100, ssh.id);
    expect([...w.links.forProfile(a.id)]).toEqual([[100, ssh.id]]);
    expect([...w.links.forProfile(b.id)]).toEqual([]);
    expect(() => w.rpc.linkGuest(a.id, 100, b.id)).toThrow(/SSH or RDP/);
    w.rpc.linkGuest(a.id, 100, null);
    expect([...w.links.forProfile(a.id)]).toEqual([]);
  });

  it("deleting a connection forgets its links", () => {
    const w = world();
    const a = w.book.save({ fields: PVE });
    const ssh = w.book.save({ fields: SSH });
    w.rpc.linkGuest(a.id, 100, ssh.id);
    w.rpc.onProfileDeleted(ssh.id);
    expect([...w.links.forProfile(a.id)]).toEqual([]);
  });
});

const admin = { host: "pve.test", port: 8006, trust: null, adminUser: "root@pam", adminPassword: ADMIN_PW, aclPath: "/", userId: USER };
const applyInput = { ...admin, name: "my pve", planDigest: DIGEST, replaceRole: false };

describe("onboarding mode 1: the plan", () => {
  it("returns the plan with its digest and what the user already holds, and reads only", async () => {
    const w = world();
    const extras = { acl: [{ path: "/", role: "PVEAdmin" }], groups: ["admins"], tokens: ["ci"] };
    w.state.provision = async () => ({ ok: true, kind: "plan", plan: { ...PLAN, user: "rotate_password", extras } });
    const plan = await w.rpc.onboardPlan(admin);
    expect(plan).toEqual({ ok: true, ...PLAN, user: "rotate_password", extras });
    expect(w.calls[0]?.arg).toMatchObject({ dryRun: true, aclPath: "/", userId: USER, connect: { user: "root@pam", password: ADMIN_PW } });
    expect(w.book.list()).toEqual([]);
  });

  it("the audit record names the endpoint, the admin, the user and the ACL path, never the password", async () => {
    const w = world();
    await w.rpc.onboardPlan({ ...admin, aclPath: "/pool/lab" });
    await w.rpc.onboardApply({ ...applyInput, aclPath: "/pool/lab" });
    expect(w.rows.map((r) => r.tool)).toEqual(["pve.onboard_plan", "pve.onboard_apply"]);
    for (const row of w.rows) {
      expect(row.detail).toBe("pve.test:8006 as root@pam user remotehub@pve acl /pool/lab");
      expect(JSON.stringify(row)).not.toContain(ADMIN_PW);
    }
  });

  it("carries a refusal's certificate to the caller and remembers it for the one pin that may follow", async () => {
    const w = world();
    w.state.provision = async () => ({ ok: false, code: "tls_untrusted", message: "m", fingerprint: FP, steps: null });
    expect(await w.rpc.onboardPlan(admin)).toEqual({ ok: false, code: "tls_untrusted", message: "m", fingerprint: FP, steps: null });
    w.state.provision = async () => ({ ok: true, kind: "plan", plan: PLAN });
    expect(await w.rpc.onboardPlan({ ...admin, trust: { mode: "pin", fingerprint: FP } })).toMatchObject({ ok: true });
  });

  it("refuses a pin that no refusal of this endpoint showed, in every entry point", async () => {
    const w = world();
    const pin = { mode: "pin" as const, fingerprint: FP };
    await expect(w.rpc.onboardPlan({ ...admin, trust: pin })).rejects.toThrow(PveRpcError);
    await expect(w.rpc.onboardApply({ ...applyInput, trust: pin })).rejects.toThrow(PveRpcError);
    await expect(w.rpc.onboardConnect({ host: "pve.test", port: 8006, trust: pin, name: "x", authMode: "ticket", user: "a@pve", secret: "pw-1234567" })).rejects.toThrow(PveRpcError);
    expect(w.book.list()).toEqual([]);
    expect(w.calls).toEqual([]);
    // A refusal on another endpoint does not authorise a pin here.
    w.state.provision = async () => ({ ok: false, code: "tls_untrusted", message: "", fingerprint: FP, steps: null });
    await w.rpc.onboardPlan({ ...admin, host: "other.pve.test" });
    await expect(w.rpc.onboardPlan({ ...admin, trust: pin })).rejects.toThrow(PveRpcError);
  });
});

describe("onboarding mode 1: applying the confirmed plan", () => {
  it("creates a connection as the managed user whose credential is the one the helper saved, bound to this endpoint and user", async () => {
    const w = world();
    const r = await w.rpc.onboardApply(applyInput);
    expect(r).toMatchObject({ ok: true, userId: USER, steps: DONE });
    if (!r.ok) throw new Error("not ok");
    const p = w.book.get(r.profileId);
    expect(p).toMatchObject({ protocol: "pve", name: "my pve", host: "pve.test", port: null, username: USER, authType: "password" });
    expect(p?.credentialRef).toBe("rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b77");
    const apply = w.calls.find((c) => c.kind === "provision")?.arg as { save: Array<{ ref: string; bind: unknown }>; dryRun: boolean; planDigest: string; replaceRole?: boolean };
    expect(apply).toMatchObject({ dryRun: false, planDigest: DIGEST });
    expect(apply.replaceRole).toBeUndefined();
    expect(apply.save.map((s) => s.bind)).toEqual([{ type: "endpoint", protocol: "pve", host: "pve.test", port: 8006, user: USER, domain: null }]);
    expect(w.meta.get(apply.save[0]!.ref)?.bind).toEqual(apply.save[0]!.bind);
    expect(JSON.stringify([...w.meta.rows.values(), ...w.book.list()])).not.toContain(ADMIN_PW);
  });

  it("replacing a differing role is passed on only when the owner asked for it", async () => {
    const w = world();
    await w.rpc.onboardApply({ ...applyInput, replaceRole: true });
    expect((w.calls.find((c) => c.kind === "provision")?.arg as { replaceRole?: boolean }).replaceRole).toBe(true);
  });

  it("a rotation updates the credential of a connection saved earlier, so it keeps working, and creates no second one", async () => {
    const w = world();
    const earlier = withRef(w);
    const r = await w.rpc.onboardApply(applyInput);
    if (!r.ok) throw new Error("not ok");
    expect(r.profileId).toBe(earlier.id);
    expect(w.book.list().filter((p) => p.protocol === "pve")).toHaveLength(1);
    const apply = w.calls.find((c) => c.kind === "provision")?.arg as { save: Array<{ ref: string }> };
    expect(apply.save.map((s) => s.ref)).toEqual([REF1]);
    expect(w.items.get(REF1)).toBe("helper-saved-secret");
    expect(w.book.get(earlier.id)?.credentialRef).toBe(REF1);
  });

  it("an earlier connection without a credential receives the new one instead of a duplicate being created", async () => {
    const w = world();
    const bare = w.book.save({ fields: PVE });
    const r = await w.rpc.onboardApply(applyInput);
    if (!r.ok) throw new Error("not ok");
    expect(r.profileId).toBe(bare.id);
    expect(w.book.list()).toHaveLength(1);
    expect(w.book.get(bare.id)?.credentialRef).not.toBeNull();
  });

  it("a connection for another user on the same server is left alone", async () => {
    const w = world();
    withRef(w, { username: "someone@pve" });
    const r = await w.rpc.onboardApply(applyInput);
    if (!r.ok) throw new Error("not ok");
    expect(w.book.list().filter((p) => p.protocol === "pve")).toHaveLength(2);
    expect((w.calls.find((c) => c.kind === "provision")?.arg as { save: unknown[] }).save).toHaveLength(1);
  });

  it("a refusal before any write (plan_changed, name_taken...) leaves nothing behind and passes the code and steps on", async () => {
    const w = world();
    const untouched: PveSteps = { role: "not_attempted", user: "not_attempted", acl: "not_attempted" };
    w.state.provision = async () => ({ ok: false, code: "plan_changed", message: "m", fingerprint: null, steps: untouched });
    expect(await w.rpc.onboardApply(applyInput)).toEqual({ ok: false, code: "plan_changed", message: "m", fingerprint: null, steps: untouched });
    expect(w.book.list()).toEqual([]);
    expect(w.meta.rows.size).toBe(0);
  });

  it("when the user step failed, the connection is removed and the steps say what exists on the server", async () => {
    const w = world();
    const steps: PveSteps = { role: "done", user: "failed", acl: "not_attempted" };
    w.state.provision = async () => ({ ok: false, code: "api_error", message: "PVE answered 500", fingerprint: null, steps });
    const r = await w.rpc.onboardApply(applyInput);
    expect(r).toMatchObject({ ok: false, code: "api_error", steps });
    expect((r as { profileId?: string }).profileId).toBeUndefined();
    expect(w.book.list()).toEqual([]);
  });

  it("when the ACL step failed after the user step, the connection and its credential are kept, flagged, and reported", async () => {
    const w = world();
    const steps: PveSteps = { role: "done", user: "done", acl: "failed" };
    w.state.provision = async () => ({ ok: false, code: "api_error", message: "PVE answered 500", fingerprint: null, steps });
    const r = await w.rpc.onboardApply(applyInput);
    if (r.ok) throw new Error("ok");
    expect(r).toMatchObject({ code: "api_error", steps });
    const kept = w.book.get(r.profileId as string);
    expect(kept?.credentialRef).not.toBeNull();
    expect(kept?.recentErrors.at(-1)?.code).toBe("setup_incomplete");
    expect(w.items.get(kept!.credentialRef as string)).toBe("helper-saved-secret");
  });

  it("running the setup again completes it on the same connection and clears the flag", async () => {
    const w = world();
    w.state.provision = async () => ({ ok: false, code: "api_error", message: "m", fingerprint: null, steps: { role: "done", user: "done", acl: "failed" } });
    const failed = await w.rpc.onboardApply(applyInput);
    if (failed.ok) throw new Error("ok");
    w.state.provision = async (arg) => (arg.dryRun ? { ok: true, kind: "plan", plan: PLAN } : { ok: true, kind: "applied", steps: { role: "kept", user: "done", acl: "done" } });
    const again = await w.rpc.onboardApply(applyInput);
    expect(again).toMatchObject({ ok: true, profileId: failed.profileId });
    expect(w.book.list().filter((p) => p.protocol === "pve")).toHaveLength(1);
    expect(w.book.get(failed.profileId as string)?.recentErrors).toEqual([]);
  });

  it("when the Keychain item is missing after a successful apply the new connection is removed again", async () => {
    const w = world();
    w.state.skipSave = true;
    const r = await w.rpc.onboardApply(applyInput);
    expect(r).toMatchObject({ ok: false, code: "credential_missing" });
    expect(w.book.list()).toEqual([]);
  });

  it("a custom port and a pinned certificate (one the refusal showed) are kept on the connection", async () => {
    const w = world();
    w.state.provision = async () => ({ ok: false, code: "tls_untrusted", message: "", fingerprint: FP, steps: null });
    await w.rpc.onboardPlan({ ...admin, port: 8443 });
    w.state.provision = async () => ({ ok: true, kind: "applied", steps: DONE });
    const r = await w.rpc.onboardApply({ ...applyInput, port: 8443, trust: { mode: "pin", fingerprint: FP } });
    if (!r.ok) throw new Error("not ok");
    expect(w.book.get(r.profileId)).toMatchObject({ port: 8443, pveTrust: { mode: "pin", fingerprint: FP } });
  });
});

describe("opening a console", () => {
  const guests = (over: Record<string, unknown> = {}) => [
    { vmid: 100, name: "db", kind: "qemu", node: "pve1", status: "running", template: false, ...over },
    { vmid: 101, name: "ct", kind: "lxc", node: "pve2", status: "running", template: false },
    { vmid: 102, name: "off", kind: "lxc", node: "pve1", status: "stopped", template: false },
  ];
  const nodes = [
    { node: "pve1", status: "online" },
    { node: "pve2", status: "online" },
  ];
  function readyWorld() {
    const w = world();
    const p = withRef(w);
    w.state.targets = async () => ({ ok: true, version: "9.2.4", nodes, guests: guests() }) as PveAnswer;
    return { w, p };
  }

  it("re-reads the guest's current node and opens with the saved credential, never a secret", async () => {
    const { w, p } = readyWorld();
    const r = await w.rpc.openConsole({ profileId: p.id, console: "lxc", vmid: 101, cols: 100, rows: 30 });
    expect(r).toEqual({ ok: true, handle: { generation: "e".repeat(32), sessionId: 7 }, kind: "pve" });
    const open = w.calls.find((c) => c.kind === "pveOpen")?.arg as { connect: { credentialRef: string; password?: string }; target: unknown; cols: number; guestName: string };
    expect(open.target).toEqual({ kind: "lxc", node: "pve2", vmid: 101 });
    expect(open.connect.credentialRef).toBe(REF1);
    expect(open.connect.password).toBeUndefined();
    expect(open).toMatchObject({ cols: 100, guestName: "ct" });
    // a fresh read was made for it, even though a list may have been cached
    expect(w.calls.filter((c) => c.kind === "targets")).toHaveLength(1);
  });

  it("a QEMU guest opens as a vnc session; a node shell as a pve one", async () => {
    const { w, p } = readyWorld();
    expect(await w.rpc.openConsole({ profileId: p.id, console: "qemu", vmid: 100, cols: 80, rows: 24 })).toMatchObject({ ok: true, kind: "vnc" });
    expect(await w.rpc.openConsole({ profileId: p.id, console: "node", node: "pve1", cols: 80, rows: 24 })).toMatchObject({ ok: true, kind: "pve" });
  });

  it("a stopped guest is refused with its reason and nothing is opened", async () => {
    const { w, p } = readyWorld();
    expect(await w.rpc.openConsole({ profileId: p.id, console: "lxc", vmid: 102, cols: 80, rows: 24 })).toMatchObject({ ok: false, code: "guest_stopped" });
    expect(w.calls.some((c) => c.kind === "pveOpen")).toBe(false);
  });

  it("a failed read is the reason, with the certificate a refusal showed, and nothing is opened from old data", async () => {
    const { w, p } = readyWorld();
    await w.rpc.targets({ refresh: true }); // a good list is now cached
    w.state.targets = async () => ({ ok: false, code: "unreachable", message: "", fingerprint: null });
    const r = await w.rpc.openConsole({ profileId: p.id, console: "lxc", vmid: 101, cols: 80, rows: 24 });
    expect(r).toMatchObject({ ok: false, code: "unreachable" });
    w.state.targets = async () => ({ ok: false, code: "tls_untrusted", message: "", fingerprint: FP });
    expect(await w.rpc.openConsole({ profileId: p.id, console: "lxc", vmid: 101, cols: 80, rows: 24 })).toMatchObject({ ok: false, code: "tls_untrusted", fingerprint: FP });
    expect(w.calls.some((c) => c.kind === "pveOpen")).toBe(false);
  });

  it("a connection without a credential, or edited while it was read, is refused", async () => {
    const w = world();
    const bare = w.book.save({ fields: PVE });
    expect(await w.rpc.openConsole({ profileId: bare.id, console: "node", node: "pve1", cols: 80, rows: 24 })).toMatchObject({ ok: false, code: "no_credential" });
    const { w: w2, p } = readyWorld();
    w2.state.targets = async () => {
      w2.book.save({ id: p.id, fields: { ...profileFields(w2.book.get(p.id)!), name: "renamed" } });
      return { ok: true, version: "9.2.4", nodes, guests: guests() } as PveAnswer;
    };
    expect(await w2.rpc.openConsole({ profileId: p.id, console: "lxc", vmid: 101, cols: 80, rows: 24 })).toMatchObject({ ok: false, code: "api_error" });
    expect(w2.calls.some((c) => c.kind === "pveOpen")).toBe(false);
  });

  it("a helper refusal at open is an answer with its code", async () => {
    const { w, p } = readyWorld();
    w.state.openError = new HelperRequestError("invalid_request", "bad target");
    expect(await w.rpc.openConsole({ profileId: p.id, console: "lxc", vmid: 101, cols: 80, rows: 24 })).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("is audited with the endpoint and the target, and the outcome", async () => {
    const { w, p } = readyWorld();
    await w.rpc.openConsole({ profileId: p.id, console: "lxc", vmid: 101, cols: 80, rows: 24 });
    await w.rpc.openConsole({ profileId: p.id, console: "lxc", vmid: 102, cols: 80, rows: 24 });
    expect(w.rows.map((r) => [r.tool, r.detail, r.outcome])).toEqual([
      ["pve.console_open", "pve.test:8006 lxc 101", "ok"],
      ["pve.console_open", "pve.test:8006 lxc 102", "guest_stopped"],
    ]);
  });
});

describe("onboarding mode 2 (connect as is)", () => {
  it("saves the connection and the secret for exactly that connection, creating nothing in Proxmox", async () => {
    const w = world();
    const r = await w.rpc.onboardConnect({ host: "pve.test", port: 8006, trust: null, name: "mine", authMode: "token", user: "me@pve!rh", secret: "tok-secret-1" });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(w.book.get(r.profileId)).toMatchObject({ authType: "token", username: "me@pve!rh" });
    expect([...w.items.values()]).toEqual(["tok-secret-1"]);
    expect(w.calls).toEqual([]);
  });

  it("a failed secret save leaves no connection behind", async () => {
    const w = world();
    const bad = await w.rpc.onboardConnect({ host: "pve.test", port: 8006, trust: null, name: "mine", authMode: "ticket", user: "not-a-valid-user", secret: "x" }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(Error);
    expect(w.book.list()).toEqual([]);
  });
});
