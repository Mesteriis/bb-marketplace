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
  /** Called with a short code when the open history could not be written; never with a message. */
  onHistoryError?: ((code: string) => void) | undefined;
}

/** What an open actually connects to, for attributing it to a profile. */
export interface OpenEndpoint {
  protocol: "ssh" | "rdp";
  host: string;
  port: number;
  user: string | null;
  domain: string | null;
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
/** The shape of a failure code worth keeping; anything else is stored as "unknown". */
const HISTORY_CODE = /^[a-z0-9_]{1,64}$/;

export class ProfileBook {
  constructor(private readonly deps: ProfileBookDeps) {}

  list(): Profile[] {
    return this.deps.store.all();
  }

  get(id: string): Profile | null {
    return this.deps.store.get(id);
  }

  /** The profiles that point at a credential. */
  usersOf(ref: string): Profile[] {
    return this.deps.store.all().filter((p) => p.credentialRef === ref);
  }

  /** Sets or clears a profile's credential reference (only the credential book calls this). */
  link(id: string, ref: string | null): Profile {
    const profile = this.deps.store.get(id);
    if (profile === null) throw new ProfileError("not_found", "no such profile");
    const next = profileSchema.parse({ ...profile, credentialRef: ref, updatedAt: this.deps.now().toISOString() });
    this.deps.store.put(next);
    return next;
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
    const kept = HISTORY_CODE.test(code) ? code : "unknown";
    const recentErrors = [...profile.recentErrors, { at: this.deps.now().toISOString(), code: kept }].slice(-RECENT_ERRORS_MAX);
    this.deps.store.put({ ...profile, recentErrors });
  }

  /**
   * The profile id an open may be attributed to: the id only when the stored
   * profile exists and the endpoint of the open is the profile's own (protocol,
   * host, port, user and, for RDP, domain). Otherwise undefined: the open still
   * runs, unattributed, and no profile's history is touched.
   */
  attribute(profileId: string | undefined, endpoint: OpenEndpoint): string | undefined {
    if (profileId === undefined) return undefined;
    const p = this.deps.store.get(profileId);
    if (p === null || p.protocol !== endpoint.protocol || p.host !== endpoint.host) return undefined;
    const defaultPort = p.protocol === "rdp" ? 3389 : 22;
    if ((p.port ?? defaultPort) !== endpoint.port) return undefined;
    if ((p.username ?? null) !== endpoint.user) return undefined;
    if (p.protocol === "rdp" && (p.domain ?? null) !== endpoint.domain) return undefined;
    return p.id;
  }

  /** Runs an open on behalf of a profile and records its outcome. Without a profile id it just runs. */
  async track<T>(profileId: string | undefined, run: () => Promise<T>): Promise<T> {
    if (profileId === undefined) return run();
    let value: T;
    try {
      value = await run();
    } catch (error) {
      const raw = (error as { code?: unknown } | null)?.code;
      this.history(() => this.recordFailure(profileId, typeof raw === "string" ? raw : "open_failed"));
      throw error;
    }
    this.history(() => this.recordOpen(profileId));
    return value;
  }

  /** The history is a convenience: a failing write is reported, never allowed to change the open's outcome. */
  private history(write: () => void): void {
    try {
      write();
    } catch (error) {
      const raw = (error as { code?: unknown } | null)?.code;
      try {
        this.deps.onHistoryError?.(typeof raw === "string" && /^[A-Za-z0-9_]{1,64}$/.test(raw) ? raw : "history_write_failed");
      } catch {
        // The reporter must not break the open either.
      }
    }
  }
}
