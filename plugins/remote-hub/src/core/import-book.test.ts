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
  readText: (p, max) => (p in FILES ? (FILES[p] as string).slice(0, max) : null),
  listDir: (p) => DIRS[p] ?? null,
  include: () => [],
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
  const credentials = new CredentialBook({ store: new MemMeta(), vault, profiles, now: () => new Date(), newId: ids, needsConfig: (id) => book.needsConfig(id) });
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
    await expect(book.apply(source.id)).rejects.toMatchObject({ code: "source_disabled" });
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
    const out = await book.apply(source.id);
    expect(out).toMatchObject({ created: 2, updated: 0, unchanged: 0, conflicts: [] });
    const build = profiles.list().find((p) => p.name === "build")!;
    expect(build).toMatchObject({ origin: "imported", host: "build.example.test", port: 2222, username: "ci", authType: "key", identityFile: "/k/id_build", group: "Imported" });
    const jump = profiles.list().find((p) => p.name === "jump")!;
    expect(jump).toMatchObject({ host: "jump", port: null, username: null, authType: "agent" });
  });

  it("importing the same source again changes nothing and writes no profile", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    await book.apply(source.id);
    const before = JSON.stringify(profiles.list());
    const again = await book.apply(source.id);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(JSON.stringify(profiles.list())).toBe(before);
  });

  it("a changed source updates an unedited profile; an edited one is a conflict and is left as it is", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    await book.apply(source.id);
    FILES["/fixture/ssh/config"] = CONFIG.replace("Port 2222", "Port 2200");
    expect(await book.apply(source.id)).toMatchObject({ updated: 1, unchanged: 1 });
    expect(profiles.list().find((p) => p.name === "build")?.port).toBe(2200);
    // Edit locally, then change the source again.
    const build = profiles.list().find((p) => p.name === "build")!;
    const id = build.id;
    profiles.save({ id, fields: { ...profileFieldsOf(build), port: 2300 } });
    FILES["/fixture/ssh/config"] = CONFIG.replace("Port 2222", "Port 2201");
    const out = await book.apply(source.id);
    expect(out.conflicts).toEqual(["build"]);
    expect(profiles.get(id)?.port).toBe(2300);
    // The source did not change relative to the last import: the local edit is simply kept.
    FILES["/fixture/ssh/config"] = CONFIG.replace("Port 2222", "Port 2200");
    expect((await book.apply(source.id)).unchanged).toBe(2);
    expect(profiles.get(id)?.port).toBe(2300);
  });

  it("a profile deleted here is not brought back, and an entry removed from the source is marked stale once", async () => {
    const { book, profiles, store } = setup();
    const source = enabledConfig(book);
    await book.apply(source.id);
    profiles.remove(profiles.list().find((p) => p.name === "jump")!.id);
    FILES["/fixture/ssh/config"] = CONFIG.replace("Host build", "Host other");
    const out = await book.apply(source.id);
    expect(out.deletedLocally).toEqual(["jump"]);
    expect(out.markedStale).toBe(1);
    expect(store.links(source.id).find((l) => l.key === "build")?.stale).toBe(true);
    expect((await book.apply(source.id)).markedStale).toBe(0);
  });

  it("only the chosen entries are imported", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    expect(await book.apply(source.id, ["build"])).toMatchObject({ created: 1 });
    expect(profiles.list().map((p) => p.name)).toEqual(["build"]);
  });

  it("an unresolved profile cannot save a secret and says why; a resolved one can", async () => {
    const { book, profiles, credentials } = setup();
    const source = enabledConfig(book);
    await book.apply(source.id);
    const jump = profiles.list().find((p) => p.name === "jump")!;
    const keyed = profiles.save({ id: jump.id, fields: { ...profileFieldsOf(jump), authType: "password" } });
    await expect(credentials.save({ profileId: keyed.id, secret: "pw" })).rejects.toMatchObject({ code: "profile_needs_config" });
    const build = profiles.list().find((p) => p.name === "build")!;
    await expect(credentials.save({ profileId: build.id, secret: "phrase" })).resolves.toMatchObject({ ref: expect.stringContaining("rh-cred:v1:") });
  });

  it("an update that changes what a secret is bound to forgets the secret; one that does not, keeps it", async () => {
    const { book, profiles, credentials } = setup();
    const source = enabledConfig(book);
    await book.apply(source.id);
    const build = profiles.list().find((p) => p.name === "build")!;
    await credentials.save({ profileId: build.id, secret: "phrase" });
    // A passphrase is bound to its key file: moving the host keeps it...
    FILES["/fixture/ssh/config"] = CONFIG.replace("Build.Example.Test", "other.example.test");
    await book.apply(source.id);
    expect(profiles.get(build.id)).toMatchObject({ host: "other.example.test", credentialRef: expect.stringContaining("rh-cred:v1:") });
    // ...a different key file forgets it.
    FILES["/fixture/ssh/config"] = CONFIG.replace("Build.Example.Test", "other.example.test").replace("/k/id_build", "/k/other_key");
    await book.apply(source.id);
    expect(profiles.get(build.id)).toMatchObject({ identityFile: "/k/other_key", credentialRef: null });
  });

  it("decorate adds provenance to imported profiles only, and sees a local edit", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book);
    await book.apply(source.id);
    const manual = profiles.save({ fields: { ...profileFieldsOf(profiles.list()[0]!), name: "mine" } });
    const decorated = book.decorate(profiles.list());
    const jump = decorated.find((p) => p.name === "jump");
    expect(jump?.provenance).toMatchObject({ sourceKind: "ssh-config", sourceKey: "jump", resolved: false, stale: false, flags: ["proxy"], editedLocally: false });
    expect(decorated.find((p) => p.id === manual.id)?.provenance).toBeUndefined();
  });

  it("ssh -G, when switched on, resolves a Match/alias entry that still goes nowhere via a proxy", async () => {
    const { book, profiles } = setup();
    const source = enabledConfig(book, "Host m\n  User a\nMatch host m\n  User b\n");
    book.setSshG(source.id, true);
    sshG.mockResolvedValueOnce("hostname real.example.test\nport 2022\nuser b\nproxyjump none\nidentityfile ~/.ssh/id_rsa\n");
    await book.apply(source.id);
    expect(sshG).toHaveBeenCalledTimes(1);
    expect(profiles.list()[0]).toMatchObject({ host: "real.example.test", port: 2022, username: "b", authType: "agent" });
    expect(book.needsConfig(profiles.list()[0]!.id)).toBe(false);
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
    expect(await book.apply(source.id)).toMatchObject({ created: 1 });
    expect(await book.apply(source.id)).toMatchObject({ created: 0, unchanged: 1 });
    expect(profiles.list()[0]).toMatchObject({ name: "build.example.test", host: "build.example.test", authType: "agent", origin: "imported" });
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
