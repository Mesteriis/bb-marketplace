import type { Capability, Endpoint, Entry, EntryKind, Fingerprint } from "./model.ts";
import type { NameSegment, ResourcePath } from "./path.ts";

export interface ListPage {
  entries: Entry[];
  cursor: string | null;
}

export interface WriteSession {
  /**
   * Temporary path on this endpoint, stable until commit or abort.
   * After a lost session the provider leaves it for reconciliation.
   */
  readonly tempPath: ResourcePath;

  /**
   * Write to the already opened temporary file. Never report already_exists.
   * After the call resolves, stat(tempPath) should show the written size. A
   * provider with buffered handles may show less (never more than offset plus
   * bytes written); the runner then records the observed size and does not fail.
   */
  write(offset: bigint, bytes: Uint8Array, signal: AbortSignal): Promise<void>;

  /**
   * With replace=false, fail atomically with already_exists if the target exists.
   * As part of replacement, the provider must check a non-null expectTarget
   * against the current target. On mismatch, report changed_since_plan;
   * callers surface this as a target_changed conflict.
   */
  commit(
    opts: { replace: boolean; expectTarget: Fingerprint | null },
    signal: AbortSignal,
  ): Promise<Fingerprint>;

  /** Remove the temporary file. Safe to call repeatedly. */
  abort(): Promise<void>;
}

/** Providers report failures as CommanderError. */
export interface FileProvider {
  readonly endpoint: Endpoint;
  /**
   * Advertise serverSideCopy exactly when copyWithin is implemented, and
   * checksum exactly when sha256 is implemented. The watch, trash and
   * permissions flags are reserved for later stages and have no stage-one methods.
   */
  readonly capabilities: ReadonlySet<Capability>;

  list(
    path: ResourcePath,
    opts: { cursor: string | null; limit: number },
    signal: AbortSignal,
  ): Promise<ListPage>;

  /** Returns null when the entry does not exist. */
  stat(path: ResourcePath, signal: AbortSignal): Promise<Entry | null>;

  /** With expect set, compare size and mtime before reading or throw changed_since_plan. */
  read(
    path: ResourcePath,
    offset: bigint,
    length: number,
    expect: Fingerprint | null,
    signal: AbortSignal,
  ): Promise<Uint8Array>;

  /**
   * Exclusively create the caller's unique, job-owned temporary name beside the
   * target. Report already_exists on collision and return that exact tempPath.
   */
  openWrite(target: ResourcePath, opts: { tempName: NameSegment }, signal: AbortSignal): Promise<WriteSession>;

  mkdir(path: ResourcePath, signal: AbortSignal): Promise<void>;

  /**
   * Check the expected target version or absence immediately before renaming.
   * Report changed_since_plan on mismatch. Document any non-atomic check window.
   * If from and to name one entry (they differ only in case on a case-insensitive
   * endpoint), the caller passes replace: true and expectTarget = the source's
   * fingerprint; the provider checks it as usual. With replace: true the provider
   * does not emulate the replacement with a separate removal of the target: if
   * there is no atomic rename over an existing target, it reports unsupported.
   */
  rename(
    from: ResourcePath,
    to: ResourcePath,
    opts: { replace: boolean; expectTarget?: Fingerprint | "absent" },
    signal: AbortSignal,
  ): Promise<void>;

  /**
   * A directory must be empty. Check the expected entry version immediately
   * before removal; report changed_since_plan on mismatch. Document any
   * non-atomic check window.
   */
  remove(path: ResourcePath, opts: { kind: EntryKind; expect?: Fingerprint }, signal: AbortSignal): Promise<void>;

  /**
   * As part of confirmed replacement, the provider must check expectTarget:
   * a fingerprint must still match and "absent" requires no target.
   * On mismatch, report changed_since_plan for a target_changed conflict.
   */
  copyWithin?(
    from: ResourcePath,
    to: ResourcePath,
    opts: { replace: boolean; expectTarget?: Fingerprint | "absent" },
    signal: AbortSignal,
  ): Promise<Fingerprint>;

  sha256?(path: ResourcePath, signal: AbortSignal): Promise<string>;

  /**
   * Integrity barrier after the last read of an entry (archives: size and CRC/AES confirmed by the helper).
   * Callers invoke it once after reading the whole entry and before committing anything; it also runs
   * for an empty entry that was never read. A failure means the bytes read must not be published.
   */
  finishRead?(path: ResourcePath, expect: Fingerprint | null, signal: AbortSignal): Promise<void>;
}

export const READ_CHUNK_MAX = 4 * 1024 * 1024;
export const LIST_PAGE_MAX = 1000;
