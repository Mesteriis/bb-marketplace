import { describe, expect, it, vi } from "vitest";
import { CredentialBook, CredentialError, type CredentialMeta, type CredentialMetaStore, type CredentialVault } from "../../core/credential.ts";
import { ProfileBook, type ProfileStore } from "../../core/profile-book.ts";
import type { Profile, ProfileFields } from "../../core/profile.ts";
import { HelperRequestError } from "./helper-process.ts";
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
  };
  const handlers = createRpcHandlers({ service: service as unknown as RemoteHubService, profiles, credentials });
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
