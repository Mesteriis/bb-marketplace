import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommanderError } from "../../core/errors.ts";

/**
 * Private working directories for archive copies and pack staging (S14 spec §7). They live on the machine of the
 * server, which is where the helper runs: <tmpdir>/commander-archives-<installId>/<run>/. Each run holds a lock
 * file (pid and process start time). Cleanup at start removes only run directories of this install whose lock
 * owner is gone; a neighbour that is alive, or anything that cannot be judged, is left alone.
 */

/** A start time string, "gone" when no such process exists, or null when the process list cannot be read. */
export type ProcessStart = string | "gone" | null;

export interface ArchiveDirs {
  readonly runDir: string;
  init(): Promise<void>;
  newCopyDir(id: string): Promise<string>;
  dispose(): Promise<void>;
}

export function psStart(pid: number): Promise<ProcessStart> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
      if (error) {
        // ps exits 1 with no output when the process does not exist; anything else is "cannot tell".
        resolve(Reflect.get(error, "code") === 1 && stdout.trim() === "" ? "gone" : null);
        return;
      }
      const text = stdout.trim();
      resolve(/^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(text) ? text : null);
    });
  });
}

export function createArchiveDirs(deps: {
  tmpdir: string;
  installId: string;
  pid: number;
  uid: number;
  readStart?: (pid: number) => Promise<ProcessStart>;
}): ArchiveDirs {
  const readStart = deps.readStart ?? psStart;
  const base = join(deps.tmpdir, `commander-archives-${deps.installId}`);
  let runDir = "";

  async function checkBase(): Promise<void> {
    const stat = lstatSync(base);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== deps.uid || (stat.mode & 0o077) !== 0) {
      throw new CommanderError("internal", "The archive work directory is not private");
    }
  }

  async function owned(dir: string): Promise<boolean> {
    const stat = await lstat(dir).catch(() => null);
    return !!stat && !stat.isSymbolicLink() && stat.isDirectory() && stat.uid === deps.uid;
  }

  async function sweep(): Promise<void> {
    for (const name of await readdir(base)) {
      const dir = join(base, name);
      if (dir === runDir || !(await owned(dir))) continue;
      let lock: { pid: number; startedAt: string };
      try {
        const parsed = JSON.parse(readFileSync(join(dir, "lock"), "utf8")) as unknown;
        if (typeof parsed !== "object" || parsed === null) continue;
        const { pid, startedAt } = parsed as Record<string, unknown>;
        if (!Number.isInteger(pid) || typeof startedAt !== "string") continue;
        lock = { pid: pid as number, startedAt };
      } catch {
        continue;
      }
      const start = await readStart(lock.pid);
      // Unreadable process list: the owner counts as alive. A different start time means the pid was reused.
      // A lock written while ps was unreadable ("unknown") cannot prove reuse, so only a missing process kills it.
      const dead = start === "gone" || (start !== null && lock.startedAt !== "unknown" && start !== lock.startedAt);
      if (dead) await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    get runDir() {
      return runDir;
    },
    async init() {
      await mkdir(base, { recursive: true, mode: 0o700 });
      await checkBase();
      await sweep();
      runDir = await mkdtemp(join(base, "run-"));
      await chmod(runDir, 0o700);
      const own = (await readStart(deps.pid)) ?? "unknown";
      await writeFile(join(runDir, "lock"), JSON.stringify({ pid: deps.pid, startedAt: own }), { mode: 0o600, flag: "wx" });
    },
    async newCopyDir(id) {
      const dir = join(runDir, id);
      await mkdir(dir, { mode: 0o700 });
      await chmod(dir, 0o700);
      return dir;
    },
    async dispose() {
      if (runDir) await rm(runDir, { recursive: true, force: true });
    },
  };
}
