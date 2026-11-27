import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { CommanderError } from "../../../core/errors.ts";
import { type Fingerprint } from "../../../core/model.ts";
import { parent, type NameSegment, type ResourcePath } from "../../../core/path.ts";
import { changed, fingerprint, hashFile, matches, withRegularFile } from "./files.ts";
import { hasErrno } from "./errors.ts";
import { type NamePlatform } from "./names.ts";
import { childPath, decodeName, encodeName, lstatOrNull, requireDirectory, resolvePath, sameNode } from "./paths.ts";

type TargetVersion = Fingerprint | "absent" | null | undefined;
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
    private readonly scheduleExpiry: ScheduleExpiry = defaultSchedule,
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

  private async createStage(target: ResourcePath, session: string, signal: AbortSignal, retain?: () => Lease) {
    const resolved = await resolvePath(target, this.platform, { target: true });
    const tempName = stagingName(target.segments.at(-1)!, session, this.platform);
    const directory = resolved.parentStats!;
    const temp = childPath(resolved.parent!, tempName);
    signal.throwIfAborted();
    const lease = retain?.();
    try {
      const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      return { file, target, directory, tempName, lease };
    } catch (error) {
      await lease?.dispose();
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

  commit(session: string, replace: boolean, expect: TargetVersion, signal: AbortSignal): Promise<Fingerprint> {
    return this.run(session, async (stage) => {
      const { file, target, directory, tempName } = stage;
      signal.throwIfAborted();
      return this.publish(async () => {
        signal.throwIfAborted();
        try {
          await file.chmod(0o644 & ~process.umask());
          await file.sync();
          const stagedStats = await file.stat({ bigint: true });
          const resolved = await resolvePath(target, this.platform, { target: true });
          if (!sameNode(resolved.parentStats!, directory)) throw changed();
          const temp = childPath(resolved.parent!, tempName);
          const currentTemp = await lstatOrNull(temp);
          if (!currentTemp || !sameNode(currentTemp, stagedStats)) throw changed();
          await this.checkTarget(resolved.full, expect, signal);
          signal.throwIfAborted();
          if (replace && expect !== "absent") {
            await rename(temp, resolved.full);
            await this.finish(session, stage);
          } else {
            try {
              await link(temp, resolved.full);
            } catch (error) {
              if (expect === "absent" && hasErrno(error, "EEXIST")) throw changed();
              throw error;
            }
            await this.finish(session, stage, temp);
          }
          return fingerprint(stagedStats);
        } catch (error) {
          // A failed publish keeps the stage available for retry/abort, with private permissions.
          if (this.sessions.has(session)) await file.chmod(0o600);
          throw error;
        }
      });
    });
  }

  // Serialize version checks and mutations within this worker, including across sessions.
  publish<T>(use: () => Promise<T>): Promise<T> {
    const result = this.publishing.then(use);
    this.publishing = result.then(() => {}, () => {});
    return result;
  }

  private async checkTarget(full: string | Buffer, expect: TargetVersion, signal: AbortSignal): Promise<void> {
    if (expect == null) return;
    const stats = await lstatOrNull(full);
    if (stats?.isSymbolicLink()) throw new CommanderError("permission_denied", "Symbolic link at target");
    if (expect === "absent") {
      if (stats) throw changed();
      return;
    }
    if (!stats?.isFile() || !matches(stats, expect)) throw changed();
    if (expect.sha256) {
      const hex = await withRegularFile(full, stats, signal, async (file, opened) => {
        if (!matches(opened, expect)) throw changed();
        return hashFile(file, signal);
      });
      const current = await lstatOrNull(full);
      if (hex !== expect.sha256 || !current || !sameNode(stats, current) || !matches(current, expect)) throw changed();
    }
  }

  abort(session: string): Promise<void> {
    return this.run(session, async (stage) => {
      let tempToRemove: string | Buffer | undefined;
      try {
        const directory = await resolvePath(parent(stage.target)!, this.platform);
        if (directory.stats && sameNode(directory.stats, stage.directory)) {
          requireDirectory(directory.stats);
          const temp = childPath(directory.full, stage.tempName);
          const current = await lstatOrNull(temp);
          const staged = await stage.file.stat({ bigint: true });
          if (current && sameNode(current, staged)) tempToRemove = temp;
        }
      } finally {
        await this.finish(session, stage, tempToRemove);
      }
    }, () => {});
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const outcomes = await Promise.allSettled([...this.sessions.keys()].map((session) => this.abort(session)));
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  }

  private async finish(session: string, stage: StagedFile, temp?: string | Buffer) {
    this.sessions.delete(session);
    try {
      if (temp) await unlink(temp);
    } finally {
      try {
        await stage.file.close();
      } finally {
        await stage.lease?.dispose();
      }
    }
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
    record.cancelExpiry = this.scheduleExpiry(() => this.abort(session), IDLE_MS);
  }
}
