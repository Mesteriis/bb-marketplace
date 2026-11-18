// Saved credentials (stage 3b): metadata here, the secret in the Keychain (behind
// the CredentialVault port, implemented by the helper). A credential is bound to
// the endpoint (or key file) it was saved for and is refused anywhere else. The
// secret is only ever passed DOWN (save/update); nothing here returns one.
import { z } from "zod";
import { DEFAULT_RDP_PORT } from "./catalogue.ts";
import type { ProfileBook } from "./profile-book.ts";
import { LOCAL_EXECUTION_HOST_ID, type Profile, type ProfileInput } from "./profile.ts";

export class CredentialError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "CredentialError";
    this.code = code;
  }
}

export const credentialBindSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("endpoint"),
    protocol: z.enum(["ssh", "rdp"]),
    host: z.string(),
    port: z.number().int(),
    user: z.string().nullable(),
    domain: z.string().nullable(),
  }),
  z.object({ type: z.literal("key"), path: z.string() }),
]);

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
  save(ref: string, secret: string): Promise<void>;
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
  protocol: "ssh" | "rdp";
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
    host: p.host,
    port: p.port ?? (p.protocol === "rdp" ? DEFAULT_RDP_PORT : 22),
    user: p.username,
    domain: p.protocol === "rdp" ? p.domain : null,
  };
}

function bindOf(p: Profile): CredentialBind {
  if (p.authType === "key" && p.identityFile !== null) return { type: "key", path: p.identityFile };
  return { type: "endpoint", ...endpointOf(p) };
}

const sameBind = (a: CredentialBind, b: CredentialBind): boolean => JSON.stringify(a) === JSON.stringify(b);

export class CredentialBook {
  constructor(private readonly deps: CredentialBookDeps) {}

  list(): CredentialView[] {
    return this.deps.store.all().map((meta) => ({
      ref: meta.ref,
      kind: meta.kind,
      label: meta.label,
      bind: meta.bind,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      usedBy: this.deps.profiles.usersOf(meta.ref).map((p) => ({ id: p.id, name: p.name })),
    }));
  }

  /** Saves a secret for a profile (password for password auth, key passphrase for key auth) and links it. */
  async save(input: { profileId: string; secret: string }): Promise<{ ref: string }> {
    if (input.secret.length === 0) throw new CredentialError("empty_secret", "the secret is empty");
    const profile = this.deps.profiles.get(input.profileId);
    if (profile === null) throw new CredentialError("profile_not_found", "no such profile");
    if (profile.authType === "agent") throw new CredentialError("credential_not_applicable", "this profile does not use a stored secret");
    if (profile.credentialRef !== null) throw new CredentialError("credential_exists", "this profile already has a saved credential; update it");
    const ref = `rh-cred:v1:${LOCAL_EXECUTION_HOST_ID}:${this.deps.newId()}`;
    await this.deps.vault.save(ref, input.secret);
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
      await this.deps.vault.delete(ref).catch(() => undefined);
      throw error;
    }
    return { ref };
  }

  async update(ref: string, secret: string): Promise<void> {
    if (secret.length === 0) throw new CredentialError("empty_secret", "the secret is empty");
    const meta = this.deps.store.get(ref);
    if (meta === null) throw new CredentialError("credential_unknown", "no such credential");
    await this.deps.vault.save(ref, secret);
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
  async delete(ref: string): Promise<{ unlinked: number }> {
    try {
      await this.deps.vault.delete(ref);
    } catch (error) {
      if (!(error instanceof CredentialError && error.code === "credential_missing")) throw error;
    }
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
  async saveProfile(input: ProfileInput): Promise<{ profile: Profile; credentialDropped: boolean; credentialError?: string }> {
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
  async deleteProfile(id: string, deleteCredential: boolean): Promise<{ deleted: boolean; credentialDeleted: boolean; credentialError?: string }> {
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
