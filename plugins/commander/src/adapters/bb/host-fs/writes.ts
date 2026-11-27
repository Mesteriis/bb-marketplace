import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { CommanderError } from "../../../core/errors.ts";
import { type Fingerprint } from "../../../core/model.ts";
import { join, parent, type NameSegment, type ResourcePath } from "../../../core/path.ts";
import { changed, fingerprint, hashFile, noFollow, requireVersion, verifyVersionHash, type ExpectedVersion } from "./files.ts";
import { hasErrno, linkUnavailable } from "./errors.ts";
import { type NamePlatform } from "./names.ts";
import { childPath, decodeName, encodeName, lstatOrNull, recheckParent, requireAbsent, resolvePath, sameNode } from "./paths.ts";

type PublishedFile = Fingerprint & { atomicNoReplace?: false; orphanedTempPath?: ResourcePath };
type CleanupResult = { orphanedTempPath?: ResourcePath };
export type StagingOrphan = {
  session: string;
  tempPath: ResourcePath;
  reason: "parent_changed" | "cleanup_failed";
};
export interface WriteOptions {
  scheduleExpiry?: ScheduleExpiry;
  link?: typeof link;
  unlink?: typeof unlink;
  hashTarget?: typeof hashFile;
  onOrphan?: (orphan: StagingOrphan) => void | Promise<void>;
}
type Lease = { dispose(): Promise<void> };
export type ScheduleExpiry = (callback: () => Promise<void>, delayMs: number) => () => void;

const IDLE_MS = 120_000;
const MAX_SESSIONS = 8;
const defaultSchedule: ScheduleExpiry = (callback, delayMs) => {
  const timer = setTimeout(() => { void callback().catch(() => {}); }, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

interface StagedFile {
  file: FileHandle;
  target: ResourcePath;
  directory: BigIntStats;
  tempName: NameSegment;
  lease?: Lease;
}

interface Session {
  stage: Promise<StagedFile>;
  tail: Promise<void>;
  cancelExpiry?: () => void;
}

function stagingName(name: NameSegment, session: string, platform: NamePlatform): NameSegment {
  const suffix = Buffer.from(".commander-" + session + ".part");
  // Leave room for the suffix when the destination already uses NAME_MAX.
  let prefix = encodeName(name).subarray(0, 254 - suffix.length);
  if ("t" in name) {
    while (!("t" in decodeName(prefix))) prefix = prefix.subarray(0, -1);
  }
  const bytes = Buffer.concat([Buffer.from("."), prefix, suffix]);
  return platform === "win32" ? { t: bytes.toString("utf8") } : decodeName(bytes);
}

export class WriteSessions {
  private readonly sessions = new Map<string, Session>();
  private disposed = false;
  private publishing = Promise.resolve();

  constructor(
    private readonly platform: NamePlatform,
    private readonly options: WriteOptions,
  ) {}

  async open(target: ResourcePath, signal: AbortSignal, retain?: () => Lease) {
    if (this.disposed) throw new CommanderError("cancelled", "Worker disposed");
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new CommanderError("limit_exceeded", "Too many active write sessions");
    }
    const session = randomUUID();
    const stage = this.createStage(target, session, signal, retain);
    const record: Session = { stage, tail: stage.then(() => {}, () => {}) };
    this.sessions.set(session, record);
    try {
      const { tempName } = await stage;
      this.armExpiry(session, record);
      return { session, tempName };
    } catch (error) {
      this.sessions.delete(session);
      throw error;
    }
  }

  /** Windows lacks O_NOFOLLOW. Exclusive creation is followed by an inode check against lstat. */
  private async createStage(target: ResourcePath, session: string, signal: AbortSignal, retain?: () => Lease) {
    const resolved = await resolvePath(target, this.platform, { target: true });
    const tempName = stagingName(target.segments.at(-1)!, session, this.platform);
    const directory = resolved.parentStats!;
    const temp = childPath(resolved.parent!, tempName);
    signal.throwIfAborted();
    await recheckParent(resolved);
    signal.throwIfAborted();
    const lease = retain?.();
    let file: FileHandle;
    try {
      file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    } catch (error) {
      await lease?.dispose();
      throw error;
    }
    const stage = { file, target, directory, tempName, lease };
    try {
      const opened = await file.stat({ bigint: true });
      const current = await lstatOrNull(temp);
      if (!current?.isFile() || !sameNode(current, opened)) throw changed();
      await recheckParent(resolved);
      return stage;
    } catch (error) {
      await this.finish(session, stage, true);
      throw error;
    }
  }

  write(session: string, offset: number, bytes: Buffer, signal: AbortSignal): Promise<void> {
    return this.run(session, async ({ file }) => {
      let start = 0;
      while (start < bytes.length) {
        signal.throwIfAborted();
        const { bytesWritten } = await file.write(bytes, start, bytes.length - start, offset + start);
        if (bytesWritten === 0) throw new CommanderError("internal", "Could not advance staged write");
        start += bytesWritten;
      }
    });
  }

  /**
   * Preserve POSIX permission bits when replacing a file. Extended attributes
   * and ACLs of the old target are not copied to the staged inode.
   */
  commit(session: string, replace: boolean, expect: ExpectedVersion, signal: AbortSignal): Promise<PublishedFile> {
    return this.run(session, async (stage) => {
      const { file, target, directory, tempName } = stage;
      signal.throwIfAborted();
      await file.sync();
      const stagedStats = await file.stat({ bigint: true });
      const hashed = await verifyVersionHash(
        () => resolvePath(target, this.platform, { target: true }), expect, signal, this.options.hashTarget,
      );
      return this.publish(async () => {
        signal.throwIfAborted();
        const resolved = await resolvePath(target, this.platform, { target: true });
        if (!sameNode(resolved.parentStats!, directory)) throw changed();
        const temp = childPath(resolved.parent!, tempName);
        const currentTemp = await lstatOrNull(temp);
        if (!currentTemp?.isFile() || !sameNode(currentTemp, stagedStats)) throw changed();
        await recheckParent(resolved);
        const currentTarget = await lstatOrNull(resolved.full);
        if (currentTarget?.isSymbolicLink()) throw new CommanderError("permission_denied", "Symbolic link at target");
        if (expect && expect !== "absent" && currentTarget && !currentTarget.isFile()) throw changed();
        requireVersion(currentTarget, expect, hashed);
        const mode = replace && currentTarget?.isFile()
          ? Number(currentTarget.mode & 0o7777n)
          : 0o644 & ~process.umask();
        let cleanup = false;
        let atomicNoReplace: false | undefined;
        try {
          signal.throwIfAborted();
          await file.chmod(mode);
          if (replace && expect !== "absent") {
            await rename(temp, resolved.full);
          } else {
            try {
              await (this.options.link ?? link)(temp, resolved.full);
              cleanup = true;
            } catch (error) {
              if (expect === "absent" && hasErrno(error, "EEXIST")) throw changed();
              if (!linkUnavailable(error)) throw error;
              await file.chmod(0o600);
              await recheckParent(resolved);
              const fallbackTemp = await lstatOrNull(temp);
              if (!fallbackTemp?.isFile() || !sameNode(fallbackTemp, stagedStats)) throw changed();
              if (expect && expect !== "absent") {
                requireVersion(await lstatOrNull(resolved.full), expect, hashed);
              }
              await requireAbsent(resolved.full, expect === "absent");
              signal.throwIfAborted();
              await file.chmod(mode);
              await rename(temp, resolved.full);
              atomicNoReplace = false;
            }
          }
        } catch (error) {
          try {
            await file.chmod(0o600);
          } catch {
            await this.finish(session, stage, true);
          }
          throw error;
        }
        // Publication succeeded. Cleanup and reporting cannot change this outcome.
        return {
          ...fingerprint(stagedStats),
          ...(atomicNoReplace === false ? { atomicNoReplace } : {}),
          ...await this.finish(session, stage, cleanup),
        };
      });
    });
  }

  // Serialize version checks and mutations within this worker, including across sessions.
  publish<T>(use: () => Promise<T>): Promise<T> {
    const result = this.publishing.then(use);
    this.publishing = result.then(() => {}, () => {});
    return result;
  }

  abort(session: string): Promise<CleanupResult> {
    return this.run(session, (stage) => this.publish(() => this.finish(session, stage, true)), () => ({}));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.sessions.keys()].map((session) => this.abort(session)));
  }

  private async removeStage(stage: StagedFile): Promise<StagingOrphan["reason"] | undefined> {
    const { target, directory, tempName, file } = stage;
    const resolved = await resolvePath(parent(target)!, this.platform);
    if (!resolved.stats?.isDirectory() || !sameNode(resolved.stats, directory)) return "parent_changed";
    const temp = childPath(resolved.full, tempName);
    const staged = await file.stat({ bigint: true });
    const current = await lstatOrNull(temp);
    if (!current) return;
    if (!current.isFile() || !sameNode(current, staged)) return "cleanup_failed";
    const currentParent = await lstatOrNull(resolved.full);
    if (!currentParent?.isDirectory() || !sameNode(currentParent, directory)) return "parent_changed";
    try {
      await (this.options.unlink ?? unlink)(temp);
    } catch (error) {
      if (!hasErrno(error, "ENOENT")) throw error;
    }
  }

  private async finish(session: string, stage: StagedFile, cleanup: boolean): Promise<CleanupResult> {
    this.sessions.delete(session);
    let reason: StagingOrphan["reason"] | undefined;
    if (cleanup) {
      try {
        reason = await this.removeStage(stage);
      } catch (error) {
        reason = hasErrno(error, "ENOENT") || (error instanceof CommanderError && (
          error.code === "permission_denied" || error.code === "not_a_directory"
        )) ? "parent_changed" : "cleanup_failed";
      }
    }
    try {
      await stage.file.close();
    } catch {
      reason ??= "cleanup_failed";
    }
    try {
      await stage.lease?.dispose();
    } catch {
      reason ??= "cleanup_failed";
    }
    if (!reason) return {};
    const tempPath = join(parent(stage.target)!, stage.tempName);
    const orphan = { session, tempPath, reason };
    const warn = () => { console.warn("[commander] Staging requires reconciliation", { session, reason }); };
    const report = this.options.onOrphan;
    if (report) void Promise.resolve().then(() => report(orphan)).catch(warn);
    else warn();
    return { orphanedTempPath: tempPath };
  }

  private async run<T>(
    session: string,
    use: (stage: StagedFile) => Promise<T>,
    onMissing: () => T = () => { throw new CommanderError("not_found", "Write session expired or does not exist"); },
  ): Promise<T> {
    const record = this.sessions.get(session);
    if (!record) return onMissing();
    record.cancelExpiry?.();
    const result = record.tail.then(async () => {
      if (this.sessions.get(session) !== record) return onMissing();
      return use(await record.stage);
    });
    const tail = result.then(() => {}, () => {});
    record.tail = tail;
    void tail.then(() => {
      if (record.tail === tail) this.armExpiry(session, record);
    });
    return result;
  }

  private armExpiry(session: string, record: Session) {
    if (this.disposed || this.sessions.get(session) !== record) return;
    record.cancelExpiry?.();
    record.cancelExpiry = (this.options.scheduleExpiry ?? defaultSchedule)(async () => { await this.abort(session); }, IDLE_MS);
  }
}
