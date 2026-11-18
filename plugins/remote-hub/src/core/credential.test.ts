import { describe, expect, it } from "vitest";
import { CredentialBook, CredentialError, type CredentialMeta, type CredentialMetaStore, type CredentialVault } from "./credential.ts";
import { ProfileBook, type ProfileStore } from "./profile-book.ts";
import type { Profile, ProfileFields } from "./profile.ts";

const SECRET = "S3cr3t-BOOK-1";

class MemoryProfiles implements ProfileStore {
  rows = new Map<string, Profile>();
  all = () => [...this.rows.values()];
  get = (id: string) => this.rows.get(id) ?? null;
  put = (p: Profile) => void this.rows.set(p.id, p);
  remove = (id: string) => this.rows.delete(id);
}
class MemoryMeta implements CredentialMetaStore {
  rows = new Map<string, CredentialMeta>();
  failPut = false;
  all = () => [...this.rows.values()];
  get = (ref: string) => this.rows.get(ref) ?? null;
  put = (m: CredentialMeta) => {
    if (this.failPut) throw new Error("disk full");
    this.rows.set(m.ref, m);
  };
  remove = (ref: string) => this.rows.delete(ref);
}
class FakeVault implements CredentialVault {
  items = new Map<string, string>();
  calls: string[] = [];
  failWith: string | null = null;
  binds = new Map<string, unknown>();
  async save(ref: string, secret: string, bind?: unknown) {
    this.binds.set(ref, bind);
    this.calls.push("save " + ref);
    if (this.failWith !== null) throw new CredentialError(this.failWith);
    this.items.set(ref, secret);
  }
  async delete(ref: string) {
    this.calls.push("delete " + ref);
    if (this.failWith !== null) throw new CredentialError(this.failWith);
    if (!this.items.delete(ref)) throw new CredentialError("credential_missing");
  }
  async status(ref: string): Promise<"present" | "missing"> {
    if (this.failWith !== null) throw new CredentialError(this.failWith);
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
const SSH_AGENT: ProfileFields = { ...RDP, name: "agent", protocol: "ssh", domain: null, authType: "agent", port: 22 };

function setup() {
  const profileStore = new MemoryProfiles();
  let n = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const profiles = new ProfileBook({ store: profileStore, now: () => new Date("2026-11-18T10:00:00.000Z"), newId: ids });
  const meta = new MemoryMeta();
  const vault = new FakeVault();
  const book = new CredentialBook({ store: meta, vault, profiles, now: () => new Date("2026-11-18T10:00:00.000Z"), newId: ids });
  return { profiles, meta, vault, book };
}

describe("CredentialBook.save", () => {
  it("stores the secret in the vault, only metadata in the store, and links the profile", async () => {
    const { profiles, meta, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    expect(ref).toBe("rh-cred:v1:local:00000000-0000-4000-8000-000000000002");
    expect(vault.items.get(ref)).toBe(SECRET);
    expect(JSON.stringify([...meta.rows.values()])).not.toContain(SECRET);
    expect(meta.get(ref)).toEqual({
      ref,
      kind: "password",
      label: "win",
      bind: { type: "endpoint", protocol: "rdp", host: "win.example.test", port: 3389, user: "admin", domain: "CORP" },
      executionHostId: "local",
      createdAt: "2026-11-18T10:00:00.000Z",
      updatedAt: "2026-11-18T10:00:00.000Z",
    });
    expect(profiles.list()[0]?.credentialRef).toBe(ref);
  });

  it("hands the vault what the secret is for, so the helper can enforce it: the endpoint, or the key file", async () => {
    const { profiles, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    expect(vault.binds.get(ref)).toEqual({ type: "endpoint", protocol: "rdp", host: "win.example.test", port: 3389, user: "admin", domain: "CORP" });
    const ssh = profiles.save({ fields: { ...SSH_AGENT, name: "key", authType: "key", identityFile: "/k/id" } });
    const saved = await book.save({ profileId: ssh.id, secret: SECRET });
    expect(vault.binds.get(saved.ref)).toEqual({ type: "key", path: "/k/id" });
    // An update keeps the stored binding.
    await book.update(ref, "second");
    expect(vault.binds.get(ref)).toEqual({ type: "endpoint", protocol: "rdp", host: "win.example.test", port: 3389, user: "admin", domain: "CORP" });
  });

  it("refuses an agent-auth profile, an unknown profile and a profile that already has one", async () => {
    const { profiles, book } = setup();
    const agent = profiles.save({ fields: SSH_AGENT });
    await expect(book.save({ profileId: agent.id, secret: SECRET })).rejects.toMatchObject({ code: "credential_not_applicable" });
    await expect(book.save({ profileId: "11111111-2222-4333-8444-555555555555", secret: SECRET })).rejects.toMatchObject({ code: "profile_not_found" });
    const p = profiles.save({ fields: RDP });
    await book.save({ profileId: p.id, secret: SECRET });
    await expect(book.save({ profileId: p.id, secret: SECRET })).rejects.toMatchObject({ code: "credential_exists" });
  });

  it("a vault failure stores nothing and links nothing; the code is the vault's", async () => {
    const { profiles, meta, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    vault.failWith = "keychain_locked";
    await expect(book.save({ profileId: p.id, secret: SECRET })).rejects.toMatchObject({ code: "keychain_locked" });
    expect(meta.all()).toEqual([]);
    expect(profiles.list()[0]?.credentialRef).toBeNull();
  });

  it("when recording the metadata fails after the vault write, the vault item is removed again", async () => {
    const { profiles, meta, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    meta.failPut = true;
    await expect(book.save({ profileId: p.id, secret: SECRET })).rejects.toThrow("disk full");
    expect(vault.items.size).toBe(0);
    expect(profiles.list()[0]?.credentialRef).toBeNull();
  });

  it("an empty secret is refused before anything is written", async () => {
    const { profiles, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    await expect(book.save({ profileId: p.id, secret: "" })).rejects.toMatchObject({ code: "empty_secret" });
    expect(vault.calls).toEqual([]);
  });
});

describe("update, status, list and delete", () => {
  it("update replaces the secret under the same ref and touches updatedAt", async () => {
    const { profiles, vault, book, meta } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    await book.update(ref, "second");
    expect(vault.items.get(ref)).toBe("second");
    expect(meta.get(ref)?.createdAt).toBe("2026-11-18T10:00:00.000Z");
    await expect(book.update("rh-cred:v1:local:00000000-0000-4000-8000-0000000000ff", "x")).rejects.toMatchObject({ code: "credential_unknown" });
  });

  it("status reports present or missing, and a keychain refusal as a state instead of throwing", async () => {
    const { profiles, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    expect(await book.status(ref)).toBe("present");
    vault.items.clear();
    expect(await book.status(ref)).toBe("missing");
    vault.failWith = "keychain_locked";
    expect(await book.status(ref)).toBe("locked");
    vault.failWith = "keychain_unavailable";
    expect(await book.status(ref)).toBe("unavailable");
    vault.failWith = "keychain_denied";
    expect(await book.status(ref)).toBe("denied");
  });

  it("list shows metadata with the profiles that use each credential, never a secret", async () => {
    const { profiles, book } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    const views = book.list();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ ref, kind: "password", label: "win", usedBy: [{ id: p.id, name: "win" }] });
    expect(JSON.stringify(views)).not.toContain(SECRET);
  });

  it("delete removes the secret and the metadata and unlinks the profiles; a locked keychain keeps everything", async () => {
    const { profiles, vault, book, meta } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    vault.failWith = "keychain_locked";
    await expect(book.delete(ref)).rejects.toMatchObject({ code: "keychain_locked" });
    expect(meta.get(ref)).not.toBeNull();
    expect(profiles.list()[0]?.credentialRef).toBe(ref);
    vault.failWith = null;
    expect(await book.delete(ref)).toEqual({ unlinked: 1 });
    expect(meta.all()).toEqual([]);
    expect(vault.items.size).toBe(0);
    expect(profiles.list()[0]?.credentialRef).toBeNull();
  });

  it("delete of a credential whose Keychain item is already gone still cleans the metadata", async () => {
    const { profiles, vault, book, meta } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    vault.items.clear();
    expect(await book.delete(ref)).toEqual({ unlinked: 1 });
    expect(meta.all()).toEqual([]);
  });
});

describe("binding: a credential only works against the endpoint it was saved for", () => {
  const endpoint = { protocol: "rdp" as const, host: "win.example.test", port: 3389, user: "admin", domain: "CORP" };

  it("matches the exact endpoint and refuses any other host, port, user or domain", async () => {
    const { profiles, book } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    expect(book.matches(ref, endpoint)).toBe(true);
    for (const change of [{ host: "evil.example.test" }, { port: 3390 }, { user: "root" }, { domain: null }, { protocol: "ssh" as const }]) {
      expect(book.matches(ref, { ...endpoint, ...change }), JSON.stringify(change)).toBe(false);
    }
    expect(book.matches("rh-cred:v1:local:00000000-0000-4000-8000-0000000000ff", endpoint)).toBe(false);
  });
});

describe("authorizeEndpoint", () => {
  it("passes for the saved endpoint; unknown and mismatching are refused with their own codes", async () => {
    const { profiles, book } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    const endpoint = { protocol: "rdp" as const, host: "win.example.test", port: 3389, user: "admin", domain: "CORP" };
    expect(() => book.authorizeEndpoint(ref, endpoint)).not.toThrow();
    expect(() => book.authorizeEndpoint(ref, { ...endpoint, host: "evil.example.test" })).toThrow(expect.objectContaining({ code: "credential_target_mismatch" }));
    expect(() => book.authorizeEndpoint("rh-cred:v1:local:00000000-0000-4000-8000-0000000000ff", endpoint)).toThrow(expect.objectContaining({ code: "credential_unknown" }));
  });
});

describe("a profile edit that moves the endpoint drops the saved credential (it must not follow to a new host)", () => {
  it("changing host, port, user or domain removes the credential and the link; other edits keep it", async () => {
    const { profiles, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: p.id, secret: SECRET });
    const kept = await book.saveProfile({ id: p.id, fields: { ...RDP, credentialRef: ref, name: "renamed", favorite: true } });
    expect(kept.profile.credentialRef).toBe(ref);
    expect(kept.credentialDropped).toBe(false);
    for (const change of [{ host: "other.example.test" }, { port: 3390 }, { username: "root" }, { domain: null }]) {
      const again = profiles.save({ fields: RDP });
      const r2 = (await book.save({ profileId: again.id, secret: SECRET })).ref;
      const res = await book.saveProfile({ id: again.id, fields: { ...RDP, credentialRef: r2, ...change } });
      expect(res.profile.credentialRef, JSON.stringify(change)).toBeNull();
      expect(res.credentialDropped).toBe(true);
      expect(vault.items.has(r2)).toBe(false);
    }
  });
});

describe("deleting a profile", () => {
  it("with deleteCredential, removes the credential only when no other profile uses it", async () => {
    const { profiles, vault, book } = setup();
    const a = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: a.id, secret: SECRET });
    const b = profiles.save({ fields: { ...RDP, name: "twin", credentialRef: ref } });
    expect(await book.deleteProfile(a.id, true)).toEqual({ deleted: true, credentialDeleted: false });
    expect(vault.items.has(ref)).toBe(true); // b still uses it
    expect(await book.deleteProfile(b.id, true)).toEqual({ deleted: true, credentialDeleted: true });
    expect(vault.items.has(ref)).toBe(false);
  });

  it("without deleteCredential the credential stays (shown in the Credentials list as unused)", async () => {
    const { profiles, vault, book } = setup();
    const a = profiles.save({ fields: RDP });
    const { ref } = await book.save({ profileId: a.id, secret: SECRET });
    expect(await book.deleteProfile(a.id, false)).toEqual({ deleted: true, credentialDeleted: false });
    expect(vault.items.has(ref)).toBe(true);
    expect(book.list()[0]?.usedBy).toEqual([]);
  });

  it("a keychain failure while deleting the credential still deletes the profile and says so", async () => {
    const { profiles, vault, book } = setup();
    const a = profiles.save({ fields: RDP });
    await book.save({ profileId: a.id, secret: SECRET });
    vault.failWith = "keychain_locked";
    const res = await book.deleteProfile(a.id, true);
    expect(res).toEqual({ deleted: true, credentialDeleted: false, credentialError: "keychain_locked" });
    expect(profiles.list()).toEqual([]);
  });
});

describe("R4: consistency of a save", () => {
  it("a vault failure on save still asks the vault to delete the reference (the item may have been written)", async () => {
    const { profiles, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    vault.failWith = "keychain_locked";
    await expect(book.save({ profileId: p.id, secret: SECRET })).rejects.toMatchObject({ code: "keychain_locked" });
    expect(vault.calls.filter((c) => c.startsWith("delete "))).toHaveLength(1);
    expect(vault.calls[0]?.startsWith("save ")).toBe(true);
  });

  it("two saves for one profile at the same time: one succeeds, the other is refused, one secret exists", async () => {
    const { profiles, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = vault.save.bind(vault);
    vault.save = async (ref, secret) => {
      await gate;
      return original(ref, secret);
    };
    const first = book.save({ profileId: p.id, secret: "one" });
    const second = book.save({ profileId: p.id, secret: "two" });
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "credential_exists" });
    expect(vault.items.size).toBe(1);
    expect(profiles.list()[0]?.credentialRef).not.toBeNull();
  });

  it("an endpoint edit that lands while a save waits for the vault wins: the save is undone and refused", async () => {
    const { profiles, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = vault.save.bind(vault);
    vault.save = async (ref, secret) => {
      await gate;
      return original(ref, secret);
    };
    const saving = book.save({ profileId: p.id, secret: SECRET });
    const editing = book.saveProfile({ id: p.id, fields: { ...RDP, host: "elsewhere.example.test" } });
    release();
    const [saveResult, editResult] = await Promise.allSettled([saving, editing]);
    expect(editResult.status).toBe("fulfilled");
    // Whatever the order, no secret may be left bound to a host it was not saved for.
    const profile = profiles.list()[0] as Profile;
    if (profile.credentialRef !== null) {
      expect(book.matches(profile.credentialRef, { protocol: "rdp", host: profile.host, port: 3389, user: "admin", domain: "CORP" })).toBe(true);
    } else {
      expect(vault.items.size).toBe(0);
    }
    if (saveResult.status === "rejected") expect(saveResult.reason).toMatchObject({ code: "profile_changed" });
  });

  it("a cleanup that fails is not swallowed: the error names it, the entry is listed as unfinished and delete retries it", async () => {
    const { profiles, meta, vault, book } = setup();
    const p = profiles.save({ fields: RDP });
    meta.failPut = true;
    const original = vault.delete.bind(vault);
    vault.delete = async () => {
      throw new CredentialError("keychain_locked");
    };
    const error = await book.save({ profileId: p.id, secret: SECRET }).catch((e: Error) => e);
    expect(error).toMatchObject({ code: "credential_cleanup_failed" });
    const orphan = book.list().find((v) => v.orphaned);
    expect(orphan).toBeDefined();
    expect(vault.items.size).toBe(1); // the secret is still in the vault, and we know it
    vault.delete = original;
    meta.failPut = false;
    await book.delete((orphan as { ref: string }).ref);
    expect(vault.items.size).toBe(0);
    expect(book.list().some((v) => v.orphaned)).toBe(false);
  });
});
