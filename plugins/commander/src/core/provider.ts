import type { Capability, Endpoint, Entry, EntryKind, Fingerprint } from "./model.ts";
import type { ResourcePath } from "./path.ts";

export interface ListPage {
  entries: Entry[];
  cursor: string | null;
}

export interface WriteSession {
  write(offset: bigint, bytes: Uint8Array, signal: AbortSignal): Promise<void>;

  /**
   * With replace=false, fail atomically with already_exists if the target exists.
   * With expectTarget set, require the target to still match the fingerprint.
   * A fingerprint mismatch corresponds to the target_changed conflict reason.
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

  /** Stage writes in a temporary file beside the target. */
  openWrite(target: ResourcePath, signal: AbortSignal): Promise<WriteSession>;

  mkdir(path: ResourcePath, signal: AbortSignal): Promise<void>;

  rename(
    from: ResourcePath,
    to: ResourcePath,
    opts: { replace: boolean },
    signal: AbortSignal,
  ): Promise<void>;

  /** A directory must be empty. */
  remove(path: ResourcePath, opts: { kind: EntryKind }, signal: AbortSignal): Promise<void>;

  copyWithin?(
    from: ResourcePath,
    to: ResourcePath,
    opts: { replace: boolean },
    signal: AbortSignal,
  ): Promise<Fingerprint>;

  sha256?(path: ResourcePath, signal: AbortSignal): Promise<string>;
}

export const READ_CHUNK_MAX = 4 * 1024 * 1024;
export const LIST_PAGE_MAX = 1000;
