// Saved credentials (stage 3b): metadata here, the secret in the Keychain (behind
// the CredentialVault port, implemented by the helper). A credential is bound to
// the endpoint (or key file) it was saved for and is refused anywhere else. The
// secret is only ever passed DOWN (save/update); nothing here returns one.
import { z } from "zod";
import { defaultPortOf } from "./catalogue.ts";
import { credentialBindSchema } from "./credential-protocol.ts";
import type { ProfileBook } from "./profile-book.ts";
import { LOCAL_EXECUTION_HOST_ID, parseCredentialRef, type Profile, type ProfileInput } from "./profile.ts";

export class CredentialError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "CredentialError";
    this.code = code;
  }
}

export const credentialMetaSchema = z
  .object({
    ref: z.string(),
    kind: z.enum(["password", "passphrase"]),
    label: z.string().max(100),
    bind: credentialBindSchema,
    executionHostId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export { credentialBindSchema };
export type CredentialBind = z.infer<typeof credentialBindSchema>;
export type CredentialMeta = z.infer<typeof credentialMetaSchema>;
export type CredentialState = "present" | "missing" | "locked" | "denied" | "unavailable";

export interface CredentialMetaStore {
  all(): CredentialMeta[];
  get(ref: string): CredentialMeta | null;
  put(meta: CredentialMeta): void;
  remove(ref: string): boolean;
}

/** Where secrets live. Throws CredentialError with the helper's code (keychain_locked, ...). */
export interface CredentialVault {
  save(ref: string, secret: string, bind: CredentialBind): Promise<void>;
  delete(ref: string): Promise<void>;
  status(ref: string): Promise<"present" | "missing">;
}

export interface CredentialBookDeps {
  store: CredentialMetaStore;
  vault: CredentialVault;
  profiles: ProfileBook;
  now: () => Date;
  newId: () => string;
}

export interface CredentialView {
  /** True for a secret whose save did not finish and whose cleanup failed: delete retries the cleanup. */
  orphaned: boolean;
  ref: string;
  kind: CredentialMeta["kind"];
  label: string;
  bind: CredentialBind;
  createdAt: string;
  updatedAt: string;
  usedBy: Array<{ id: string; name: string }>;
}

/** What an open connects to, for checking a credential against. */
export interface Endpoint {
  protocol: "ssh" | "rdp" | "pve";
  host: string;
  port: number;
  user: string | null;
  domain: string | null;
}

const STATE_OF_CODE: Record<string, CredentialState> = {
  keychain_locked: "locked",
  keychain_denied: "denied",
  keychain_unavailable: "unavailable",
  credential_missing: "missing",
};

export function endpointOf(p: Profile): Endpoint {
  return {
    protocol: p.protocol,
    // Lower case, as OpenSSH prints it in its prompts and as the helper stores and compares it.
    host: p.host.toLowerCase(),
    port: p.port ?? defaultPortOf(p.protocol),
    user: p.username,
    domain: p.protocol === "rdp" ? p.domain : null,
  };
}

function bindOf(p: Profile): CredentialBind {
  if (p.authType === "key" && p.identityFile !== null) return { type: "key", path: p.identityFile };
  return { type: "endpoint", ...endpointOf(p) };
}

/** What a secret saved for this profile is bound to (the helper enforces it on every use). */
export const bindForProfile = (p: Profile): CredentialBind => bindOf(p);

const sameBind = (a: CredentialBind, b: CredentialBind): boolean => JSON.stringify(a) === JSON.stringify(b);

export class CredentialBook {
  /** Per-key promise chains: operations on one profile (or one credential) run one at a time. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** References whose secret may still be in the vault although no record points at it (kept in memory; a restart forgets them). */
  private readonly orphans = new Set<string>();

  constructor(private readonly deps: CredentialBookDeps) {}

  private locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  list(): CredentialView[] {
    const orphaned: CredentialView[] = [...this.orphans].map((ref) => ({
      orphaned: true,
      ref,
      kind: "password",
      label: "Unfinished save (cleanup pending)",
      bind: { type: "key", path: "" },
      createdAt: "",
      updatedAt: "",
      usedBy: [],
    }));
    return [...this.deps.store.all().map((meta) => ({
      orphaned: false,
      ref: meta.ref,
      kind: meta.kind,
      label: meta.label,
      bind: meta.bind,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      usedBy: this.deps.profiles.usersOf(meta.ref).map((p) => ({ id: p.id, name: p.name })),
    })), ...orphaned];
  }

  /** Saves a secret for a profile (password for password auth, key passphrase for key auth) and links it. */
  save(input: { profileId: string; secret: string }): Promise<{ ref: string }> {
    return this.locked("profile:" + input.profileId, () => this.saveLocked(input));
  }

  private async saveLocked(input: { profileId: string; secret: string }): Promise<{ ref: string }> {
    if (input.secret.length === 0) throw new CredentialError("empty_secret", "the secret is empty");
    const profile = this.deps.profiles.get(input.profileId);
    if (profile === null) throw new CredentialError("profile_not_found", "no such profile");
    if (profile.authType === "agent") throw new CredentialError("credential_not_applicable", "this profile does not use a stored secret");
    // An imported alias behind a proxy or a Match rule: a secret cannot be tied to where it really goes.
    if (profile.needsConfig === true) {
      throw new CredentialError("profile_needs_config", "this profile goes through your SSH configuration (a proxy, a Match rule...), so a saved secret cannot be tied to its destination");
    }
    if (profile.credentialRef !== null) throw new CredentialError("credential_exists", "this profile already has a saved credential; update it");
    const ref = `rh-cred:v1:${LOCAL_EXECUTION_HOST_ID}:${this.deps.newId()}`;
    try {
      await this.deps.vault.save(ref, input.secret, bindOf(profile));
    } catch (error) {
      // The write may have landed even though the call failed: ask for the item to be removed.
      throw CredentialBook.withNote(error, await this.cleanup(ref));
    }
    // The profile may have changed while the vault was working: the secret is only valid for the
    // profile exactly as it was when the save began.
    const now = this.deps.profiles.get(profile.id);
    if (now === null || now.credentialRef !== null || !sameBind(bindOf(now), bindOf(profile)) || now.authType !== profile.authType) {
      const left = await this.cleanup(ref);
      throw CredentialBook.withNote(new CredentialError("profile_changed", "the profile changed while its password was being saved; try again"), left);
    }
    const stamp = this.deps.now().toISOString();
    try {
      this.deps.store.put({
        ref,
        kind: profile.authType === "key" ? "passphrase" : "password",
        label: profile.name.slice(0, 100),
        bind: bindOf(profile),
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        createdAt: stamp,
        updatedAt: stamp,
      });
      this.deps.profiles.link(profile.id, ref);
    } catch (error) {
      // The secret must not outlive a record that points at it.
      this.deps.store.remove(ref);
      const left = await this.cleanup(ref);
      if (left !== null) {
        throw new CredentialError("credential_cleanup_failed", `the password could not be saved and its Keychain item could not be removed (${left}); it is listed as unfinished`);
      }
      throw error;
    }
    return { ref };
  }

  /**
   * Records a secret the helper has already put in the Keychain itself (Proxmox onboarding creates the user's password and
   * saves it where it made it): checks that it is there, keeps its metadata and links the profile. Nothing is passed down.
   */
  adopt(input: { profileId: string; ref: string }): Promise<void> {
    return this.locked("profile:" + input.profileId, () => this.adoptLocked(input));
  }

  private async adoptLocked(input: { profileId: string; ref: string }): Promise<void> {
    const profile = this.deps.profiles.get(input.profileId);
    if (profile === null) throw new CredentialError("profile_not_found", "no such profile");
    if (profile.authType === "agent") throw new CredentialError("credential_not_applicable", "this profile does not use a stored secret");
    if (profile.credentialRef !== null) throw new CredentialError("credential_exists", "this profile already has a saved credential; update it");
    const parsed = parseCredentialRef(input.ref);
    if (parsed === null || parsed.executionHostId !== LOCAL_EXECUTION_HOST_ID) throw new CredentialError("invalid_credential_ref", "not a Remote Hub credential reference");
    if ((await this.status(input.ref)) !== "present") throw new CredentialError("credential_missing", "the Keychain has no such item");
    const stamp = this.deps.now().toISOString();
    try {
      this.deps.store.put({
        ref: input.ref,
        kind: "password",
        label: profile.name.slice(0, 100),
        bind: bindOf(profile),
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        createdAt: stamp,
        updatedAt: stamp,
      });
      this.deps.profiles.link(profile.id, input.ref);
    } catch (error) {
      this.deps.store.remove(input.ref);
      const left = await this.cleanup(input.ref);
      if (left !== null) throw new CredentialError("credential_cleanup_failed", `the credential could not be recorded and its Keychain item could not be removed (${left}); it is listed as unfinished`);
      throw error;
    }
  }

  /**
   * Removes a secret that no record owns. Returns null when it is gone, or the failure code. A
   * failure is NOT swallowed: the reference is remembered (listed as unfinished, retried by
   * `delete`) and the caller puts the code in the error it throws.
   */
  private async cleanup(ref: string): Promise<string | null> {
    try {
      await this.deps.vault.delete(ref);
      return null;
    } catch (error) {
      if (error instanceof CredentialError && error.code === "credential_missing") return null; // nothing was written
      this.orphans.add(ref);
      return error instanceof CredentialError ? error.code : "keychain_unavailable";
    }
  }

  private static withNote(error: unknown, cleanupCode: string | null): unknown {
    if (cleanupCode === null || !(error instanceof CredentialError)) return error;
    return new CredentialError(error.code, `${error.message} (and the Keychain item could not be removed: ${cleanupCode}; it is listed as unfinished)`);
  }

  update(ref: string, secret: string): Promise<void> {
    return this.locked("ref:" + ref, () => this.updateLocked(ref, secret));
  }

  private async updateLocked(ref: string, secret: string): Promise<void> {
    if (secret.length === 0) throw new CredentialError("empty_secret", "the secret is empty");
    const meta = this.deps.store.get(ref);
    if (meta === null) throw new CredentialError("credential_unknown", "no such credential");
    await this.deps.vault.save(ref, secret, meta.bind);
    this.deps.store.put({ ...meta, updatedAt: this.deps.now().toISOString() });
  }

  /** The Keychain's answer as a state; a refusal is a state, not an exception. */
  async status(ref: string): Promise<CredentialState> {
    try {
      return await this.deps.vault.status(ref);
    } catch (error) {
      const code = error instanceof CredentialError ? error.code : "keychain_unavailable";
      return STATE_OF_CODE[code] ?? "unavailable";
    }
  }

  /** Removes the secret, the metadata and every profile's link to it. A locked Keychain keeps all three. */
  delete(ref: string): Promise<{ unlinked: number }> {
    return this.locked("ref:" + ref, () => this.deleteLocked(ref));
  }

  private async deleteLocked(ref: string): Promise<{ unlinked: number }> {
    try {
      await this.deps.vault.delete(ref);
    } catch (error) {
      if (!(error instanceof CredentialError && error.code === "credential_missing")) throw error;
    }
    this.orphans.delete(ref);
    this.deps.store.remove(ref);
    const users = this.deps.profiles.usersOf(ref);
    for (const p of users) this.deps.profiles.link(p.id, null);
    return { unlinked: users.length };
  }

  /** Whether a credential may be used for this endpoint: it must be the endpoint it was saved for. */
  matches(ref: string, endpoint: Endpoint): boolean {
    const meta = this.deps.store.get(ref);
    return meta !== null && meta.bind.type === "endpoint" && sameBind(meta.bind, { type: "endpoint", ...endpoint });
  }

  /** Throws unless the credential exists and was saved for exactly this endpoint. */
  authorizeEndpoint(ref: string, endpoint: Endpoint): void {
    if (this.deps.store.get(ref) === null) throw new CredentialError("credential_unknown", "no such credential");
    if (!this.matches(ref, endpoint)) {
      throw new CredentialError("credential_target_mismatch", "this credential was saved for a different host, port or user");
    }
  }

  /**
   * Throws unless the credential may be used for this SSH connection, and returns how it
   * authenticates: a password must be the one saved for exactly this host, port and user;
   * a passphrase must be the one saved for exactly this identity file.
   */
  authorizeSsh(ref: string, endpoint: Endpoint, identityFile: string | undefined): "password" | "publickey" {
    const meta = this.deps.store.get(ref);
    if (meta === null) throw new CredentialError("credential_unknown", "no such credential");
    if (meta.kind === "password") {
      // The user comes from -l: with none, ssh would use the local name and the prompt would not be the one expected.
      if (endpoint.user === null) throw new CredentialError("credential_target_mismatch", "a saved password needs a user name");
      this.authorizeEndpoint(ref, endpoint);
      return "password";
    }
    if (identityFile === undefined || !this.matchesKey(ref, identityFile)) {
      throw new CredentialError("credential_target_mismatch", "this passphrase was saved for a different key file");
    }
    return "publickey";
  }

  /** Whether a key passphrase may be used for this key file. */
  matchesKey(ref: string, path: string): boolean {
    const meta = this.deps.store.get(ref);
    return meta !== null && meta.bind.type === "key" && meta.bind.path === path;
  }

  /**
   * Saves a profile. The client cannot set a credential reference (only `save` does), and an
   * edit that moves the endpoint drops the credential: a saved secret must not follow a
   * changed host to a place the user never saved it for.
   */
  saveProfile(input: ProfileInput): Promise<{ profile: Profile; credentialDropped: boolean; credentialError?: string }> {
    return this.locked("profile:" + (input.id ?? "new"), () => this.saveProfileLocked(input));
  }

  private async saveProfileLocked(input: ProfileInput): Promise<{ profile: Profile; credentialDropped: boolean; credentialError?: string }> {
    const previous = input.id === undefined ? null : this.deps.profiles.get(input.id);
    const keptRef = previous?.credentialRef ?? null;
    const saved = this.deps.profiles.save({ ...input, fields: { ...input.fields, credentialRef: keptRef } });
    if (previous === null || keptRef === null) return { profile: saved, credentialDropped: false };
    if (sameBind(bindOf(previous), bindOf(saved)) && previous.authType === saved.authType) return { profile: saved, credentialDropped: false };
    const unlinked = this.deps.profiles.link(saved.id, null);
    const result: { profile: Profile; credentialDropped: boolean; credentialError?: string } = { profile: unlinked, credentialDropped: true };
    if (this.deps.profiles.usersOf(keptRef).length === 0) {
      try {
        await this.delete(keptRef);
      } catch (error) {
        result.credentialError = error instanceof CredentialError ? error.code : "keychain_unavailable";
      }
    }
    return result;
  }

  /** Deletes a profile; with `deleteCredential` also its credential, but only when no other profile uses it. */
  deleteProfile(id: string, deleteCredential: boolean): Promise<{ deleted: boolean; credentialDeleted: boolean; credentialError?: string }> {
    return this.locked("profile:" + id, () => this.deleteProfileLocked(id, deleteCredential));
  }

  private async deleteProfileLocked(id: string, deleteCredential: boolean): Promise<{ deleted: boolean; credentialDeleted: boolean; credentialError?: string }> {
    const profile = this.deps.profiles.get(id);
    const deleted = this.deps.profiles.remove(id);
    const ref = profile?.credentialRef ?? null;
    if (!deleted || ref === null || !deleteCredential || this.deps.profiles.usersOf(ref).length > 0) {
      return { deleted, credentialDeleted: false };
    }
    try {
      await this.delete(ref);
      return { deleted, credentialDeleted: true };
    } catch (error) {
      return { deleted, credentialDeleted: false, credentialError: error instanceof CredentialError ? error.code : "keychain_unavailable" };
    }
  }
}
