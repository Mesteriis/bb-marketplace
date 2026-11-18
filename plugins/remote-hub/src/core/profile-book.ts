// The profile book (stage 3a): create, update, duplicate, delete and the
// open history of saved profiles, over a ProfileStore port. Host-free; the
// store, the clock and the id source are injected.
import {
  LOCAL_EXECUTION_HOST_ID,
  profileInputSchema,
  profileSchema,
  type Profile,
  type ProfileInput,
} from "./profile.ts";

export interface ProfileStore {
  all(): Profile[];
  get(id: string): Profile | null;
  /** Insert or replace by id. */
  put(profile: Profile): void;
  remove(id: string): boolean;
}

export interface ProfileBookDeps {
  store: ProfileStore;
  now: () => Date;
  newId: () => string;
}

export class ProfileError extends Error {
  readonly code: "not_found";
  constructor(code: "not_found", message: string) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

const COPY_SUFFIX = " (copy)";
const RECENT_ERRORS_MAX = 5;

export class ProfileBook {
  constructor(private readonly deps: ProfileBookDeps) {}

  list(): Profile[] {
    return this.deps.store.all();
  }

  save(raw: ProfileInput): Profile {
    const input = profileInputSchema.parse(raw);
    const stamp = this.deps.now().toISOString();
    const existing = input.id === undefined ? null : this.deps.store.get(input.id);
    if (input.id !== undefined && existing === null) throw new ProfileError("not_found", "no such profile");
    const profile = profileSchema.parse({
      ...input.fields,
      id: existing?.id ?? this.deps.newId(),
      executionHostId: existing?.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
      origin: "manual",
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      lastOpenedAt: existing?.lastOpenedAt ?? null,
      recentErrors: existing?.recentErrors ?? [],
    });
    this.deps.store.put(profile);
    return profile;
  }

  /** A fresh profile from an existing one: no history, not a favourite, no credential. */
  duplicate(id: string): Profile {
    const original = this.deps.store.get(id);
    if (original === null) throw new ProfileError("not_found", "no such profile");
    const { id: _id, executionHostId: _host, origin: _origin, createdAt: _c, updatedAt: _u, lastOpenedAt: _l, recentErrors: _e, ...fields } = original;
    const name = original.name.slice(0, 100 - COPY_SUFFIX.length) + COPY_SUFFIX;
    return this.save({ fields: { ...fields, name, favorite: false, credentialRef: null } });
  }

  remove(id: string): boolean {
    return this.deps.store.remove(id);
  }

  recordOpen(id: string): void {
    const profile = this.deps.store.get(id);
    if (profile === null) return;
    this.deps.store.put({ ...profile, lastOpenedAt: this.deps.now().toISOString() });
  }

  /** Records a failure CODE (never the message: it could carry anything). */
  recordFailure(id: string, code: string): void {
    const profile = this.deps.store.get(id);
    if (profile === null) return;
    const recentErrors = [...profile.recentErrors, { at: this.deps.now().toISOString(), code: code.slice(0, 64) }].slice(-RECENT_ERRORS_MAX);
    this.deps.store.put({ ...profile, recentErrors });
  }

  /** Runs an open on behalf of a profile and records its outcome. Without a profile id it just runs. */
  async track<T>(profileId: string | undefined, run: () => Promise<T>): Promise<T> {
    if (profileId === undefined) return run();
    try {
      const value = await run();
      this.recordOpen(profileId);
      return value;
    } catch (error) {
      const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "open_failed";
      this.recordFailure(profileId, code);
      throw error;
    }
  }
}
