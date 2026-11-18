// The real files, the agent and ssh for the import book (stage 3c). Every read is bounded, and every path is
// one the user chose as a source. Policy for files (sources, public keys, Include targets alike):
//   * the path is looked at with lstat BEFORE anything is opened, and only a regular file is ever opened;
//   * a symbolic link is followed only when its target stays inside the directory the file was chosen from
//     (an Include: the config's directory); a link that leaves it is REFUSED (register the real file instead);
//   * the open is non-blocking, and the opened descriptor must be the same regular file that lstat saw, so a
//     FIFO, device or socket (which can block an open for ever) or a file swapped in between is refused;
//   * there is no way to open a private key at all.
// An Include shares one budget (files and bytes) across the whole scan.
import { experimental_execHostFile } from "@get-bb/plugin-sdk/process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DirEntry, IncludeBudget, ReadText, SourceReader } from "../../core/import-book.ts";
import type { IncludeResult, IncludedFile } from "../../core/ssh-config.ts";
import { assertHostToken } from "../../core/ssh-args.ts";

const MAX_INCLUDE_FILE_BYTES = 256 * 1024;
const EXEC_TIMEOUT_MS = 5000;

function inside(boundary: string, path: string): boolean {
  const rel = relative(boundary, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The path to open, or null when it is not a regular file this policy allows. `boundary` is a REAL directory. */
function resolveRegular(path: string, boundary: string): string | null {
  try {
    const first = lstatSync(path);
    if (first.isSymbolicLink()) {
      const real = realpathSync(path);
      if (!inside(boundary, real)) return null; // a link that leaves the directory is not followed
      return lstatSync(real).isFile() ? real : null;
    }
    return first.isFile() ? path : null;
  } catch {
    return null;
  }
}

function readRegular(path: string, boundary: string, maxBytes: number): { data: Buffer; truncated: boolean } | null {
  const target = resolveRegular(path, boundary);
  if (target === null) return null;
  let fd: number | null = null;
  try {
    const before = lstatSync(target);
    // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer, and this is synchronous.
    fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) return null;
    const buffer = Buffer.alloc(maxBytes + 1); // one more than allowed, to tell "cut" from "exactly full"
    let total = 0;
    while (total < buffer.length) {
      const n = readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
    }
    return { data: buffer.subarray(0, Math.min(total, maxBytes)), truncated: total > maxBytes };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The lookup said "nothing there" (as opposed to "could not look"). */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A pattern with `*` or `?` only in its last segment: the directory part must be literal. */
function globToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export interface FsSourceReaderOptions {
  /** The environment the agent is found in (SSH_AUTH_SOCK); the plugin's own environment otherwise. */
  env?: Record<string, string | undefined>;
  home?: string;
}

export function createFsSourceReader(options: FsSourceReaderOptions = {}): SourceReader {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  return {
    home: () => home,
    readText(path, maxBytes): ReadText | null {
      let boundary: string;
      try {
        boundary = realpathSync(dirname(path));
      } catch {
        return null;
      }
      const read = readRegular(path, boundary, maxBytes);
      return read === null ? null : { text: read.data.toString("utf8"), truncated: read.truncated };
    },
    listDir(path): DirEntry[] | null {
      try {
        return readdirSync(path, { withFileTypes: true }).map((d) => ({ name: d.name, kind: d.isFile() ? "file" : d.isDirectory() ? "dir" : "other" }));
      } catch {
        return null;
      }
    },
    include(configPath, pattern, budget: IncludeBudget): IncludeResult {
      const files: IncludedFile[] = [];
      let complete = true;
      try {
        const base = realpathSync(dirname(configPath));
        // OpenSSH anchors a relative Include of a USER config to ~/.ssh, whichever file was chosen. A config that
        // lives elsewhere would resolve differently from what we can read, so it is reported as incomplete.
        if (!isAbsolute(pattern) && !pattern.startsWith("~")) {
          let dotSsh = "";
          try {
            dotSsh = realpathSync(join(home, ".ssh"));
          } catch {
            // no ~/.ssh: nothing equals it
          }
          if (dotSsh === "" || base !== dotSsh) return { files, complete: false };
        }
        const target = isAbsolute(pattern) ? pattern : resolve(base, pattern);
        const dir = dirname(target);
        const last = basename(target);
        if (/[*?]/.test(dir)) return { files, complete: false }; // only the file name may be a pattern
        let realDir: string;
        try {
          realDir = realpathSync(dir);
        } catch (e) {
          // No such directory: nothing to include, as for ssh. Any other failure (permission...) is not absence.
          return { files, complete: isAbsent(e) };
        }
        if (realDir !== base && !inside(base, realDir)) return { files, complete: false };
        const names = /[*?]/.test(last) ? readdirSync(realDir).filter((n) => globToRegExp(last).test(n)).sort() : [last];
        for (const name of names) {
          const full = join(realDir, name);
          let exists = true;
          try {
            lstatSync(full);
          } catch (e) {
            if (!isAbsent(e)) {
              complete = false; // the lookup itself failed: not the same as "not there"
              continue;
            }
            exists = false;
          }
          if (!exists) continue; // a missing file is simply not there
          if (budget.files <= 0 || budget.bytes <= 0) {
            complete = false;
            break;
          }
          const read = readRegular(full, base, Math.min(MAX_INCLUDE_FILE_BYTES, budget.bytes));
          if (read === null) {
            complete = false; // present, but a link out, a FIFO, unreadable...
            continue;
          }
          budget.files -= 1;
          budget.bytes -= read.data.length;
          let real = full;
          try {
            real = realpathSync(full);
          } catch {
            // keep the literal path as the identity
          }
          files.push({ path: real, text: read.data.toString("utf8"), ...(read.truncated ? { truncated: true } : {}) });
        }
        return { files, complete };
      } catch {
        return { files, complete: false };
      }
    },
    async agentList() {
      try {
        const { stdout } = await experimental_execHostFile("/usr/bin/ssh-add", ["-l"], { timeout: EXEC_TIMEOUT_MS, cwd: tmpdir(), env: { PATH: "/usr/bin:/bin", ...(env.SSH_AUTH_SOCK !== undefined ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}) }, encoding: "utf8" });
        return stdout;
      } catch (error) {
        // ssh-add exits 1 with a message when the agent holds no keys, 2 when there is no agent.
        const e = error as { code?: number; stdout?: string };
        return e.code === 1 && typeof e.stdout === "string" ? e.stdout : null;
      }
    },
    async sshG(configPath, alias) {
      try {
        assertHostToken(alias);
        const { stdout } = await experimental_execHostFile("/usr/bin/ssh", ["-G", "-F", configPath, "--", alias], { timeout: EXEC_TIMEOUT_MS, cwd: tmpdir(), env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
        return stdout;
      } catch {
        return null;
      }
    },
  };
}
