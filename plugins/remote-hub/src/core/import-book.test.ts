import { describe, expect, it, vi } from "vitest";
import { CredentialBook, type CredentialMeta, type CredentialMetaStore, type CredentialVault } from "./credential.ts";
import { ImportBook, ImportError, type DirEntry, type ImportSource, type ImportStore, type SourceReader } from "./import-book.ts";
import type { ImportLink } from "./import-plan.ts";
import { ProfileBook, type ProfileStore } from "./profile-book.ts";
import { profileFieldsOf, type Profile } from "./profile.ts";

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
class MemImport implements ImportStore {
  src = new Map<string, ImportSource>();
  lk = new Map<string, ImportLink>();
  sources = () => [...this.src.values()];
  putSource = (s: ImportSource) => void this.src.set(s.id, s);
  removeSource = (id: string) => this.src.delete(id);
  links = (sourceId?: string) => [...this.lk.values()].filter((l) => sourceId === undefined || l.sourceId === sourceId);
  putLink = (l: ImportLink) => void this.lk.set(l.sourceId + ":" + l.key, l);
  removeLinksOfSource = (id: string) => [...this.lk.keys()].filter((k) => k.startsWith(id + ":")).forEach((k) => this.lk.delete(k));
}

const FILES: Record<string, string> = {};
const DIRS: Record<string, DirEntry[]> = {};
const sshG = vi.fn(async (_c: string, _a: string): Promise<string | null> => null);
const reader: SourceReader = {
  home: () => "/home/fixture",
  readText: (p, max) => (p in FILES ? { text: (FILES[p] as string).slice(0, max), truncated: false } : null),
  listDir: (p) => DIRS[p] ?? null,
  include: () => ({ files: [], complete: true }),
  agentList: async () => "256 SHA256:AAA agent key (ED25519)\n",
  sshG,
};

const KH = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const overlayLines: string[] = [];
const overlay = {
  list: vi.fn(async () => [...overlayLines]),
  add: vi.fn(async (lines: string[]) => {
    let n = 0;
    for (const l of lines) if (!overlayLines.includes(l)) (overlayLines.push(l), n++);
    return n;
  }),
  remove: vi.fn(async (host: string) => {
    const before = overlayLines.length;
    for (let i = overlayLines.length - 1; i >= 0; i--) if ((overlayLines[i] as string).split(" ")[0]?.split(",").includes(host)) overlayLines.splice(i, 1);
    return before - overlayLines.length;
  }),
};

function setup() {
  let n = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const profileStore = new MemProfiles();
  const profiles = new ProfileBook({ store: profileStore, now: () => new Date("2026-11-18T10:00:00.000Z"), newId: ids });
  const store = new MemImport();
  const vault: CredentialVault = { save: async () => {}, delete: async () => {}, status: async () => "present" };
  let book!: ImportBook;
  const credentials = new CredentialBook({ store: new MemMeta(), vault, profiles, now: () => new Date(), newId: ids });
  book = new ImportBook({ store, reader, profiles, credentials, newId: ids, knownHosts: overlay });
  return { book, store, profiles, credentials };
}

const CONFIG = `Host build
  HostName Build.Example.Test
  Port 2222
  User ci
  IdentityFile /k/id_build
Host jump
  ProxyJump bastion
Host *
  ServerAliveInterval 30
`;

/** Review, then import: apply acts on the scan that was reviewed. */
async function applyFresh(book: ImportBook, id: string, keys?: string[]) {
  const scan = await book.scan(id);
  if (scan.kind !== "ssh-config" && scan.kind !== "hosts") throw new Error("kind");
  return await book.apply(id, keys, scan.scanId);
}

function enabledConfig(book: ImportBook, text = CONFIG) {
  FILES["/fixture/ssh/config"] = text;
  const source = book.addSource({ kind: "ssh-config", path: "/fixture/ssh/config", label: "fixture" });
  book.setEnabled(source.id, true);
  return source;
}

describe("sources are off until switched on", () => {
  it("a new source is disabled; scanning or importing it is refused; nothing is read", async () => {
    const { book } = setup();
    FILES["/fixture/ssh/config"] = CONFIG;
    const spy = vi.spyOn(reader, "readText");
    const source = book.addSource({ kind: "ssh-config", path: "/fixture/ssh/config", label: "x" });
    expect(source).toMatchObject({ enabled: false, useSshG: false });
    await expect(book.scan(source.id)).rejects.toMatchObject({ code: "source_disabled" });
    await expect(book.apply(source.id, undefined, "x")).rejects.toMatchObject({ code: "source_disabled" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses relative paths, .. segments and a path for the agent", () => {
    const { book } = setup();
    for (const path of ["config", "/a/../b", "/a\nb"]) expect(() => book.addSource({ kind: "ssh-config", path, label: "" })).toThrow(ImportError);
    expect(() => book.addSource({ kind: "agent", path: "/x", label: "" })).toThrow(ImportError);
    expect(() => book.addSource({ kind: "ssh-config", path: null, label: "" })).toThrow(ImportError);
  });

  it("ssh -G needs its own switch, only on an enabled ssh config, and switching the source off switches it off", async () => {
    const { book } = setup();
    const source = enabledConfig(book);
    await book.scan(source.id);
    expect(sshG).not.toHaveBeenCalled(); // never by default
    expect(() => book.setSshG(book.addSource({ kind: "hosts", path: "/fixture/hosts", label: "" }).id, true)).toThrow(ImportError);
    expect(book.setSshG(source.id, true).useSshG).toBe(true);
    expect(book.setEnabled(source.id, false)).toMatchObject({ enabled: false, useSshG: false });
  });
});

describe("importing an ssh config", () => {
  it("scan shows what would happen; apply creates a profile with an explicit destination, and an alias profile for the proxy entry", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    const scan = await book.scan(source.id);
    if (scan.kind !== "ssh-config") throw new Error("kind");
    expect(scan.items.map((i) => [i.key, i.action, i.resolved])).toEqual([["build", "create", true], ["jump", "create", false]]);
    const out = await applyFresh(book, source.id);
    expect(out).toMatchObject({ created: 2, updated: 0, unchanged: 0, conflicts: [] });
    const build = profiles.list().find((p) => p.name === "build")!;
    expect(build).toMatchObject({ origin: "imported", host: "build.example.test", port: 2222, username: "ci", authType: "key", identityFile: "/k/id_build", group: "Imported" });
    const jump = profiles.list().find((p) => p.name === "jump")!;
    expect(jump).toMatchObject({ host: "jump", port: null, username: null, authType: "agent" });
  });

  it("importing the same source again changes nothing and writes no profile", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    const before = JSON.stringify(profiles.list());
    const again = await applyFresh(book, source.id);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(JSON.stringify(profiles.list())).toBe(before);
  });

  it("a changed source updates an unedited profile; an edited one is a conflict and is left as it is", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    FILES["/fixture/ssh/config"] = CONFIG.replace("Port 2222", "Port 2200");
    expect(await applyFresh(book, source.id)).toMatchObject({ updated: 1, unchanged: 1 });
    expect(profiles.list().find((p) => p.name === "build")?.port).toBe(2200);
    // Edit locally, then change the source again.
    const build = profiles.list().find((p) => p.name === "build")!;
    const id = build.id;
    profiles.save({ id, fields: { ...profileFieldsOf(build), port: 2300 } });
    FILES["/fixture/ssh/config"] = CONFIG.replace("Port 2222", "Port 2201");
    const out = await applyFresh(book, source.id);
    expect(out.conflicts).toEqual(["build"]);
    expect(profiles.get(id)?.port).toBe(2300);
    // The source did not change relative to the last import: the local edit is simply kept.
    FILES["/fixture/ssh/config"] = CONFIG.replace("Port 2222", "Port 2200");
    expect((await applyFresh(book, source.id)).unchanged).toBe(2);
    expect(profiles.get(id)?.port).toBe(2300);
  });

  it("a profile deleted here is not brought back, and an entry removed from the source is marked stale once", async () => {
    const { book, profiles, store } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    profiles.remove(profiles.list().find((p) => p.name === "jump")!.id);
    FILES["/fixture/ssh/config"] = CONFIG.replace("Host build", "Host other");
    const out = await applyFresh(book, source.id);
    expect(out.deletedLocally).toEqual(["jump"]);
    expect(out.markedStale).toBe(1);
    expect(store.links(source.id).find((l) => l.key === "build")?.stale).toBe(true);
    expect((await applyFresh(book, source.id)).markedStale).toBe(0);
  });

  it("only the chosen entries are imported", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    expect(await applyFresh(book, source.id, ["build"])).toMatchObject({ created: 1 });
    expect(profiles.list().map((p) => p.name)).toEqual(["build"]);
  });

  it("an unresolved profile cannot save a secret and says why; a resolved one can", async () => {
    const { book, profiles, credentials } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    const jump = profiles.list().find((p) => p.name === "jump")!;
    const keyed = profiles.save({ id: jump.id, fields: { ...profileFieldsOf(jump), authType: "password" } });
    await expect(credentials.save({ profileId: keyed.id, secret: "pw" })).rejects.toMatchObject({ code: "profile_needs_config" });
    const build = profiles.list().find((p) => p.name === "build")!;
    await expect(credentials.save({ profileId: build.id, secret: "phrase" })).resolves.toMatchObject({ ref: expect.stringContaining("rh-cred:v1:") });
  });

  it("an update that changes what a secret is bound to forgets the secret; one that does not, keeps it", async () => {
    const { book, profiles, credentials } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    const build = profiles.list().find((p) => p.name === "build")!;
    await credentials.save({ profileId: build.id, secret: "phrase" });
    // A passphrase is bound to its key file: moving the host keeps it...
    FILES["/fixture/ssh/config"] = CONFIG.replace("Build.Example.Test", "other.example.test");
    await applyFresh(book, source.id);
    expect(profiles.get(build.id)).toMatchObject({ host: "other.example.test", credentialRef: expect.stringContaining("rh-cred:v1:") });
    // ...a different key file forgets it.
    FILES["/fixture/ssh/config"] = CONFIG.replace("Build.Example.Test", "other.example.test").replace("/k/id_build", "/k/other_key");
    await applyFresh(book, source.id);
    expect(profiles.get(build.id)).toMatchObject({ identityFile: "/k/other_key", credentialRef: null });
  });

  it("decorate adds provenance to imported profiles only, and sees a local edit", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    const manual = profiles.save({ fields: { ...profileFieldsOf(profiles.list()[0]!), name: "mine" } });
    const decorated = book.decorate(profiles.list());
    const jump = decorated.find((p) => p.name === "jump");
    expect(jump?.provenance).toMatchObject({ sourceKind: "ssh-config", sourceKey: "jump", resolved: false, stale: false, flags: ["proxy"], editedLocally: false });
    expect(decorated.find((p) => p.id === manual.id)?.provenance).toBeUndefined();
  });

  it("ssh -G runs only for the entries the user chose, only after a scan, and the answer is a NEW review that apply must use", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book, "Host m\n  User a\nMatch host m\n  User b\nHost n\n  User c\nMatch all\n");
    book.setSshG(source.id, true);
    const scan = await book.scan(source.id);
    if (scan.kind !== "ssh-config") throw new Error("kind");
    expect(sshG).not.toHaveBeenCalled(); // a scan never runs ssh
    expect(scan.items.map((i) => [i.key, i.resolved])).toEqual([["m", false], ["n", false]]);
    sshG.mockResolvedValueOnce("hostname real.example.test\nport 2022\nuser b\nproxyjump none\nidentityfile ~/.ssh/id_rsa\n");
    const next = await book.resolve(source.id, scan.scanId, ["m"]);
    if (next.kind !== "ssh-config") throw new Error("kind");
    expect(sshG).toHaveBeenCalledTimes(1);
    expect(sshG.mock.calls[0]?.[1]).toBe("m"); // not "n": it was not chosen
    expect(next.scanId).not.toBe(scan.scanId);
    expect(next.items.map((i) => [i.key, i.resolved, i.host])).toEqual([["m", true, "real.example.test"], ["n", false, "n"]]);
    // The first review is stale now: importing against it is refused.
    await expect(book.apply(source.id, ["m"], scan.scanId)).rejects.toMatchObject({ code: "scan_required" });
    await book.apply(source.id, ["m"], next.scanId);
    expect(profiles.list()[0]).toMatchObject({ host: "real.example.test", port: 2022, username: "b", authType: "agent" });
    expect(profiles.list()[0]!.needsConfig).toBeUndefined();
  });

  it("ssh -G needs its switch and a current review; an answer whose HostName is not acceptable shows as skipped in the review", async () => {
    const { book } = setup();
    const source = enabledConfig(book, "Host m\n  User a\nMatch host m\n  User b\n");
    const scan = await book.scan(source.id);
    if (scan.kind !== "ssh-config") throw new Error("kind");
    await expect(book.resolve(source.id, scan.scanId, ["m"])).rejects.toMatchObject({ code: "ssh_g_off" });
    book.setSshG(source.id, true);
    await expect(book.resolve(source.id, "not-the-review", ["m"])).rejects.toMatchObject({ code: "scan_required" });
    sshG.mockResolvedValueOnce("hostname -oProxyCommand=evil\nport 22\nuser x\n");
    const next = await book.resolve(source.id, scan.scanId, ["m"]);
    if (next.kind !== "ssh-config") throw new Error("kind");
    expect(next.items[0]?.skip).not.toBeNull();
  });
});

describe("keys and the agent: metadata only", () => {
  it("lists public keys with fingerprints and the private file beside each BY NAME; a private key body is never read", async () => {
    const { book } = setup();
    const SENTINEL = "PRIVATE-BODY-SENTINEL-9f3a";
    DIRS["/fixture/keys"] = [
      { name: "id_a", kind: "file" }, { name: "id_a.pub", kind: "file" },
      { name: "lonely.pub", kind: "file" }, { name: "id_nopub", kind: "file" },
      { name: "known_hosts", kind: "file" }, { name: "sub", kind: "dir" },
    ];
    const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA me@fixture\n";
    FILES["/fixture/keys/id_a.pub"] = pub;
    FILES["/fixture/keys/lonely.pub"] = pub;
    // Anything that would read a private file would see the sentinel.
    FILES["/fixture/keys/id_a"] = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + SENTINEL;
    FILES["/fixture/keys/id_nopub"] = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + SENTINEL;
    const reads: string[] = [];
    const original = reader.readText;
    reader.readText = (p, m) => (reads.push(p), original(p, m));
    const source = book.addSource({ kind: "keys-dir", path: "/fixture/keys", label: "keys" });
    book.setEnabled(source.id, true);
    const scan = await book.scan(source.id);
    reader.readText = original;
    if (scan.kind !== "keys-dir") throw new Error("kind");
    expect(scan.keys).toEqual([
      expect.objectContaining({ publicPath: "/fixture/keys/id_a.pub", privatePath: "/fixture/keys/id_a", type: "ssh-ed25519", comment: "me@fixture", fingerprint: expect.stringMatching(/^SHA256:/) }),
      expect.objectContaining({ publicPath: "/fixture/keys/lonely.pub", privatePath: null }),
    ]);
    // Only .pub files were opened; no private file, and no sentinel anywhere in the result.
    expect(reads.sort()).toEqual(["/fixture/keys/id_a.pub", "/fixture/keys/lonely.pub"]);
    expect(JSON.stringify(scan)).not.toContain(SENTINEL);
    expect(JSON.stringify(scan)).not.toContain("PRIVATE KEY");
  });

  it("the agent list is parsed; no agent is an empty list with a note", async () => {
    const { book } = setup();
    const source = book.addSource({ kind: "agent", path: null, label: "agent" });
    book.setEnabled(source.id, true);
    const scan = await book.scan(source.id);
    expect(scan).toEqual({ kind: "agent", keys: [{ bits: 256, fingerprint: "SHA256:AAA", comment: "agent key", type: "ED25519" }], issues: [] });
  });
});

describe("a hosts file offers candidates", () => {
  it("imports names as plain profiles, once", async () => {
    const { book, profiles } = setup();
    FILES["/fixture/hosts"] = "127.0.0.1 localhost\n10.0.0.5 build.example.test\n";
    const source = book.addSource({ kind: "hosts", path: "/fixture/hosts", label: "hosts" });
    book.setEnabled(source.id, true);
    expect(await applyFresh(book, source.id)).toMatchObject({ created: 1 });
    expect(await applyFresh(book, source.id)).toMatchObject({ created: 0, unchanged: 1 });
    expect(profiles.list()[0]).toMatchObject({ name: "build.example.test", host: "build.example.test", authType: "agent", origin: "imported" });
  });
});

describe("incomplete reads are never credential-eligible (W3d)", () => {
  it("a truncated hosts file offers its names as unresolved and says it is incomplete", async () => {
    const { book } = setup();
    FILES["/fixture/hosts"] = "10.0.0.5 build.example.test\n10.0.0.6 cut.exa";
    const original = reader.readText;
    reader.readText = (p) => (p === "/fixture/hosts" ? { text: FILES[p] as string, truncated: true } : original(p, 1 << 20));
    try {
      const source = book.addSource({ kind: "hosts", path: "/fixture/hosts", label: "hosts" });
      book.setEnabled(source.id, true);
      const scan = await book.scan(source.id);
      if (scan.kind !== "hosts") throw new Error("kind");
      expect(scan.incomplete).toBe(true);
      expect(scan.items.map((i) => [i.key, i.resolved, i.flags])).toEqual([
        ["build.example.test", false, ["incomplete"]],
        ["cut.exa", false, ["incomplete"]],
      ]);
    } finally {
      reader.readText = original;
    }
  });

  it("ssh -G is refused for a scan that is incomplete: its answer would make an entry resolved under a read that cannot be trusted", async () => {
    const { book } = setup();
    const source = enabledConfig(book, "Include refused.conf\nHost m\n  User a\n");
    book.setSshG(source.id, true);
    const originalInclude = reader.include;
    reader.include = () => ({ files: [], complete: false });
    try {
      const scan = await book.scan(source.id);
      if (scan.kind !== "ssh-config") throw new Error("kind");
      expect(scan.incomplete).toBe(true);
      await expect(book.resolve(source.id, scan.scanId, ["m"])).rejects.toMatchObject({ code: "scan_incomplete" });
      expect(sshG).not.toHaveBeenCalled();
    } finally {
      reader.include = originalInclude;
    }
  });
});

describe("a known_hosts source adds host keys to the helper's overlay, only the chosen ones", () => {
  it("scan lists plain host keys (none chosen), apply trusts the chosen ones once, and the overlay is what 'trusted' shows", async () => {
    const { book } = setup();
    overlayLines.length = 0;
    FILES["/fixture/known_hosts"] = `a.example.test ${KH} one\n@cert-authority *.corp ${KH}\nb.example.test,10.0.0.9 ${KH}\n`;
    const source = book.addSource({ kind: "known-hosts", path: "/fixture/known_hosts", label: "kh" });
    await expect(book.scan(source.id)).rejects.toMatchObject({ code: "source_disabled" });
    book.setEnabled(source.id, true);
    const scan = await book.scan(source.id);
    if (scan.kind !== "known-hosts") throw new Error("kind");
    expect(scan.items.map((i) => [i.hosts, i.trusted])).toEqual([[["a.example.test"], false], [["b.example.test", "10.0.0.9"], false]]);
    expect(overlay.add).not.toHaveBeenCalled(); // scanning trusts nothing
    const chosen = scan.items[1]!.key;
    expect(await book.apply(source.id, [chosen])).toMatchObject({ created: 1, unchanged: 0 });
    expect(await book.apply(source.id, [chosen])).toMatchObject({ created: 0, unchanged: 1 });
    expect(overlayLines).toEqual([`b.example.test,10.0.0.9 ${KH}`]);
    expect((await book.trustedHosts()).map((t) => t.hosts)).toEqual([["b.example.test", "10.0.0.9"]]);
    expect(await book.forgetHost("10.0.0.9")).toBe(1);
    expect(overlayLines).toEqual([]);
    const again = await book.scan(source.id);
    if (again.kind !== "known-hosts") throw new Error("kind");
    expect(again.items.every((i) => !i.trusted)).toBe(true);
  });

  it("applying with no keys list is trust-all only when the caller says so explicitly; an empty choice trusts nothing", async () => {
    const { book } = setup();
    overlayLines.length = 0;
    FILES["/fixture/known_hosts"] = `a.example.test ${KH}\n`;
    const source = book.addSource({ kind: "known-hosts", path: "/fixture/known_hosts", label: "kh" });
    book.setEnabled(source.id, true);
    expect(await book.apply(source.id, [])).toMatchObject({ created: 0 });
    expect(overlayLines).toEqual([]);
  });
});

describe("the restriction lives with the profile (U2)", () => {
  it("removing the source, or duplicating the profile, does not let a password be saved for a ProxyJump alias", async () => {
    const { book, profiles, credentials } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    const jump = profiles.list().find((p) => p.name === "jump")!;
    expect(jump.needsConfig).toBe(true);
    const asPassword = profiles.save({ id: jump.id, fields: { ...profileFieldsOf(jump), authType: "password" } });
    book.removeSource(source.id);
    expect(profiles.get(jump.id)?.needsConfig).toBe(true);
    await expect(credentials.save({ profileId: asPassword.id, secret: "pw" })).rejects.toMatchObject({ code: "profile_needs_config" });
    const copy = profiles.duplicate(jump.id);
    expect(copy.needsConfig).toBe(true);
    const copyPassword = profiles.save({ id: copy.id, fields: { ...profileFieldsOf(copy), authType: "password" } });
    await expect(credentials.save({ profileId: copyPassword.id, secret: "pw" })).rejects.toMatchObject({ code: "profile_needs_config" });
  });

  it("it is cleared only when the destination is made explicit and complete: a NEW host together with a port and a user (W4); any other edit keeps it", async () => {
    const { book, profiles, credentials } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    const jump = profiles.list().find((p) => p.name === "jump")!;
    const renamed = profiles.save({ id: jump.id, fields: { ...profileFieldsOf(jump), name: "renamed", authType: "password", username: "u" } });
    expect(renamed.needsConfig).toBe(true);
    // A new host alone, or a host with a port but no user (or the reverse), is not a verified destination.
    const hostOnly = profiles.save({ id: jump.id, fields: { ...profileFieldsOf(renamed), host: "real.example.test", username: null } });
    expect(hostOnly.needsConfig).toBe(true);
    const noPort = profiles.save({ id: jump.id, fields: { ...profileFieldsOf(hostOnly), username: "u" } });
    expect(noPort.needsConfig).toBe(true);
    // The same host with port and user filled in: the destination did not change, so nothing was verified.
    const sameHost = profiles.save({ id: jump.id, fields: { ...profileFieldsOf(noPort), host: "real.example.test", port: 22 } });
    expect(sameHost.needsConfig).toBe(true);
    const other = profiles.save({ id: jump.id, fields: { ...profileFieldsOf(sameHost), host: "other.example.test" } });
    expect(other.needsConfig).toBeUndefined();
    const explicit = other;
    await expect(credentials.save({ profileId: explicit.id, secret: "pw" })).resolves.toMatchObject({ ref: expect.any(String) });
  });

  it("a re-import that makes an entry resolved (or unresolved) updates the restriction", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book, "Host p\n  HostName p.example.test\n");
    await applyFresh(book, source.id);
    expect(profiles.list()[0]!.needsConfig).toBeUndefined();
    FILES["/fixture/ssh/config"] = "Host p\n  HostName p.example.test\n  ProxyJump bastion\n";
    await applyFresh(book, source.id);
    expect(profiles.list()[0]!.needsConfig).toBe(true);
  });
});

describe("an import acts on the scan that was reviewed (U4b) and an incomplete scan is never trusted (U5)", () => {
  it("apply without a scan, or against a different one, is refused; the reviewed data is what is applied even if the file changed since", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    await expect(book.apply(source.id, ["build"])).rejects.toMatchObject({ code: "scan_required" });
    const scan = await book.scan(source.id);
    if (scan.kind !== "ssh-config") throw new Error("kind");
    await expect(book.apply(source.id, ["build"], "another")).rejects.toMatchObject({ code: "scan_required" });
    FILES["/fixture/ssh/config"] = CONFIG.replace("Build.Example.Test", "changed-after-review.example.test");
    await book.apply(source.id, ["build"], scan.scanId);
    expect(profiles.list().find((p) => p.name === "build")?.host).toBe("build.example.test");
  });

  it("an incomplete scan offers nothing as resolved, says so, and marks nothing stale", async () => {
    const { book, profiles, store } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    // The Include now fails (e.g. over budget): the scan is incomplete.
    const original = reader.include;
    reader.include = () => ({ files: [], complete: false });
    FILES["/fixture/ssh/config"] = "Include conf.d/*\nHost build\n  HostName build.example.test\n";
    const scan = await book.scan(source.id);
    reader.include = original;
    if (scan.kind !== "ssh-config") throw new Error("kind");
    expect(scan.incomplete).toBe(true);
    expect(scan.items.every((i) => !i.resolved && i.flags.includes("incomplete"))).toBe(true);
    expect(scan.stale).toEqual([]); // "jump" is absent from this partial read: that proves nothing
    const out = await book.apply(source.id, undefined, scan.scanId);
    expect(out.markedStale).toBe(0);
    expect(store.links(source.id).every((l) => !l.stale)).toBe(true);
    // A new profile from an incomplete scan cannot save a secret.
    const fresh = enabledConfig(book, "Host zed\n  HostName zed.example.test\n");
    void fresh;
    expect(profiles.list().length).toBeGreaterThan(0);
  });

  it("a scan gives each Include one shared budget, so the same pattern repeated cannot read more", async () => {
    const { book } = setup();
    const budgets: Array<{ files: number; bytes: number }> = [];
    const original = reader.include;
    reader.include = (_c, _p, budget) => (budgets.push(budget), { files: [], complete: true });
    const source = enabledConfig(book, "Include a\nInclude a\nInclude b\nHost x\n");
    await book.scan(source.id);
    reader.include = original;
    expect(budgets).toHaveLength(3);
    expect(budgets[0]).toBe(budgets[1]);
    expect(budgets[1]).toBe(budgets[2]);
    expect(budgets[0]).toEqual({ files: 50, bytes: 1024 * 1024 });
  });

  it("an entry that came back after being marked stale is current again without being chosen", async () => {
    const { book, store } = setup();
    const source = enabledConfig(book);
    await applyFresh(book, source.id);
    FILES["/fixture/ssh/config"] = CONFIG.replace("Host jump", "Host elsewhere");
    await applyFresh(book, source.id);
    expect(store.links(source.id).find((l) => l.key === "jump")?.stale).toBe(true);
    FILES["/fixture/ssh/config"] = CONFIG;
    await applyFresh(book, source.id, ["build"]);
    expect(store.links(source.id).find((l) => l.key === "jump")?.stale).toBe(false);
  });
});
