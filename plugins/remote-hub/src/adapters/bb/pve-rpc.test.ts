import { describe, expect, it } from "vitest";
import { CredentialBook, CredentialError, type CredentialMeta, type CredentialMetaStore, type CredentialVault } from "../../core/credential.ts";
import { ProfileBook, type ProfileStore } from "../../core/profile-book.ts";
import type { Profile, ProfileFields } from "../../core/profile.ts";
import type { PveAnswer, PveProvisionAnswer } from "../../core/pve-targets.ts";
import { createPveRpc, PveRpcError } from "./pve-rpc.ts";
import type { PveGuestLinkStore } from "./pve-sqlite.ts";

const FP = "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E";
const OTHER_FP = "36:28:12:20:8A:0A:3D:00:92:3E:DB:13:8A:D2:BF:2F:AF:AE:CC:82:6B:4E:BD:24:81:4E:6A:25:F0:35:CD:99";
const ADMIN_PW = "Admin-PW-77x";

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

function world() {
  const profiles = new MemProfiles();
  let n = 0;
  const book = new ProfileBook({ store: profiles, now: () => new Date("2026-11-18T10:00:00Z"), newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
  const meta = new MemMeta();
  const items = new Map<string, string>();
  const vaultCalls: string[] = [];
  const vault: CredentialVault = {
    async save(ref, secret) {
      vaultCalls.push("save " + ref);
      items.set(ref, secret);
    },
    async delete(ref) {
      vaultCalls.push("delete " + ref);
      if (!items.delete(ref)) throw new CredentialError("credential_missing");
    },
    async status(ref) {
      return items.has(ref) ? "present" : "missing";
    },
  };
  const credentials = new CredentialBook({ store: meta, vault, profiles: book, now: () => new Date("2026-11-18T10:00:00Z"), newId: () => `0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b${String(++n).padStart(2, "0")}` });
  const calls: Array<{ kind: string; arg: unknown }> = [];
  const state: { skipSave: boolean; targets: PveAnswer; provision: (arg: { dryRun: boolean; save?: { ref: string } }) => Promise<PveProvisionAnswer> } = {
    skipSave: false,
    targets: { ok: true, version: "9.0.3", nodes: [], guests: [{ vmid: 100, name: "db", kind: "qemu", node: "pve1", status: "running", template: false }] },
    provision: async () => ({ ok: true, applied: true, role: "create", user: "create", acl: "create" }),
  };
  const service = {
    pve: {
      targets: async (connect: unknown) => {
        calls.push({ kind: "targets", arg: connect });
        return state.targets;
      },
      provision: async (arg: { dryRun: boolean; save?: { ref: string } }) => {
        calls.push({ kind: "provision", arg });
        const answer = await state.provision(arg);
        if (answer.ok && arg.save !== undefined && !arg.dryRun && !state.skipSave) items.set(arg.save.ref, "helper-saved-secret");
        return answer;
      },
    },
    credentialVault: vault,
  };
  const links = new MemLinks();
  const rpc = createPveRpc({ service: service as never, profiles: book, credentials, links, newId: () => "0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b77", now: () => new Date("2026-11-18T10:00:00Z") });
  return { rpc, book, meta, items, vaultCalls, calls, state, links };
}

const PVE: ProfileFields = {
  name: "lab",
  protocol: "pve",
  group: null,
  tags: [],
  favorite: false,
  color: null,
  host: "pve.test",
  port: null,
  username: "remotehub@pve",
  domain: null,
  authType: "password",
  identityFile: null,
  credentialRef: null,
  rdpWidth: null,
  rdpHeight: null,
  pveTrust: null,
};
const SSH: ProfileFields = { ...PVE, name: "guest ssh", protocol: "ssh", username: "root", authType: "agent", port: null };

describe("discovery", () => {
  it("asks with the saved credential's reference, never a secret, and the profile's trust", async () => {
    const w = world();
    const p = w.book.save({ fields: { ...PVE, pveTrust: { mode: "pin", fingerprint: FP } } });
    w.items.set("rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01", "x");
    w.book.link(p.id, "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01");
    const [view] = await w.rpc.targets({ refresh: true });
    expect(view?.outcome).toBe("ok");
    expect(w.calls[0]?.arg).toEqual({
      host: "pve.test",
      port: 8006,
      authMode: "ticket",
      user: "remotehub@pve",
      credentialRef: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01",
      trust: { mode: "pin", fingerprint: FP },
    });
  });

  it("a connection without a credential is no_credential and is not asked; other protocols are not listed", async () => {
    const w = world();
    w.book.save({ fields: PVE });
    w.book.save({ fields: SSH });
    const views = await w.rpc.targets({ refresh: true });
    expect(views.map((v) => v.outcome)).toEqual(["no_credential"]);
    expect(w.calls).toEqual([]);
  });

  it("an API token connection signs in as a token", async () => {
    const w = world();
    const p = w.book.save({ fields: { ...PVE, authType: "token", username: "remotehub@pve!rh" } });
    w.book.link(p.id, "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b02");
    await w.rpc.targets({ refresh: true });
    expect((w.calls[0]?.arg as { authMode: string }).authMode).toBe("token");
  });
});

describe("pinning a certificate", () => {
  async function refused() {
    const w = world();
    const p = w.book.save({ fields: PVE });
    w.book.link(p.id, "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01");
    w.state.targets = { ok: false, code: "tls_untrusted", message: "", fingerprint: FP };
    const [view] = await w.rpc.targets({ refresh: true });
    expect(view?.outcome).toBe("tls_untrusted");
    return { w, p };
  }

  it("trusts exactly the certificate the server presented", async () => {
    const { w, p } = await refused();
    w.rpc.pinTrust(p.id, FP);
    expect(w.book.get(p.id)?.pveTrust).toEqual({ mode: "pin", fingerprint: FP });
  });

  it("refuses a fingerprint the server did not present, and one for a profile that is not Proxmox", async () => {
    const { w, p } = await refused();
    expect(() => w.rpc.pinTrust(p.id, OTHER_FP)).toThrow(PveRpcError);
    expect(w.book.get(p.id)?.pveTrust ?? null).toBeNull();
    const ssh = w.book.save({ fields: SSH });
    expect(() => w.rpc.pinTrust(ssh.id, FP)).toThrow(/no such Proxmox connection/);
  });
});

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

describe("onboarding mode 1 (restricted user)", () => {
  const admin = { host: "pve.test", port: 8006, trust: null, adminUser: "root@pam", adminPassword: ADMIN_PW, aclPath: "/" };

  it("the plan reads only and carries the admin's login in this call alone", async () => {
    const w = world();
    w.state.provision = async () => ({ ok: true, applied: false, role: "create", user: "create", acl: "create" });
    const plan = await w.rpc.onboardPlan(admin);
    expect(plan).toEqual({ ok: true, applied: false, role: "create", user: "create", acl: "create" });
    expect(w.calls[0]?.arg).toMatchObject({ dryRun: true, aclPath: "/", connect: { user: "root@pam", password: ADMIN_PW } });
    expect(w.book.list()).toEqual([]);
  });

  it("applying saves a connection as remotehub@pve whose credential is the one the helper saved, bound to this endpoint", async () => {
    const w = world();
    const r = await w.rpc.onboardApply({ ...admin, name: "my pve" });
    expect(r).toMatchObject({ ok: true, plan: { role: "create", user: "create", acl: "create" } });
    if (!r.ok) throw new Error("not ok");
    const p = w.book.get(r.profileId);
    expect(p).toMatchObject({ protocol: "pve", name: "my pve", host: "pve.test", port: null, username: "remotehub@pve", authType: "password" });
    expect(p?.credentialRef).toBe("rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b77");
    const apply = w.calls.find((c) => c.kind === "provision")?.arg as { save: { ref: string; bind: unknown }; dryRun: boolean };
    expect(apply.dryRun).toBe(false);
    expect(apply.save.bind).toEqual({ type: "endpoint", protocol: "pve", host: "pve.test", port: 8006, user: "remotehub@pve", domain: null });
    expect(w.meta.get(apply.save.ref)?.bind).toEqual(apply.save.bind);
    // The admin's password was used for the call and is nowhere in what was stored.
    expect(JSON.stringify([...w.meta.rows.values(), ...w.book.list()])).not.toContain(ADMIN_PW);
  });

  it("a refused apply leaves no connection behind and says why, with the certificate to confirm", async () => {
    const w = world();
    w.state.provision = async () => ({ ok: false, code: "tls_untrusted", message: "m", fingerprint: FP });
    const r = await w.rpc.onboardApply({ ...admin, name: "x" });
    expect(r).toEqual({ ok: false, code: "tls_untrusted", message: "m", fingerprint: FP });
    expect(w.book.list()).toEqual([]);
    expect(w.meta.rows.size).toBe(0);
  });

  it("when the Keychain item is missing after the apply the connection is removed again", async () => {
    const w = world();
    w.state.skipSave = true;
    const r = await w.rpc.onboardApply({ ...admin, name: "x" });
    expect(r).toMatchObject({ ok: false, code: "credential_missing" });
    expect(w.book.list()).toEqual([]);
  });

  it("a custom port and a pinned certificate are kept on the connection", async () => {
    const w = world();
    const r = await w.rpc.onboardApply({ ...admin, port: 8443, trust: { mode: "pin", fingerprint: FP }, name: "p" });
    if (!r.ok) throw new Error("not ok");
    expect(w.book.get(r.profileId)).toMatchObject({ port: 8443, pveTrust: { mode: "pin", fingerprint: FP } });
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
    w.items.clear();
    const bad = await w.rpc.onboardConnect({ host: "pve.test", port: 8006, trust: null, name: "mine", authMode: "ticket", user: "not-a-valid-user", secret: "x" }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(Error);
    expect(w.book.list()).toEqual([]);
  });
});
