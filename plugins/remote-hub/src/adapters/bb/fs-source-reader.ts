// The real files, the agent and ssh for the import book (stage 3c). Every read is bounded and every path is
// one the user chose as a source; an Include may only reach files inside the config's own directory. Never
// reads a path the user did not register, and has no way to open a private key at all.
import { experimental_execHostFile } from "@get-bb/plugin-sdk/process";
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DirEntry, SourceReader } from "../../core/import-book.ts";
import type { IncludedFile } from "../../core/ssh-config.ts";
import { assertHostToken } from "../../core/ssh-args.ts";

const MAX_INCLUDE_FILES = 50;
const MAX_INCLUDE_BYTES = 256 * 1024;
const EXEC_TIMEOUT_MS = 5000;

function readPrefix(path: string, maxBytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(maxBytes);
    let total = 0;
    while (total < maxBytes) {
      const n = readSync(fd, buffer, total, maxBytes - total, null);
      if (n === 0) break;
      total += n;
    }
    return buffer.subarray(0, total);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
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
    readText(path, maxBytes) {
      const data = readPrefix(path, maxBytes);
      return data === null ? null : data.toString("utf8");
    },
    listDir(path): DirEntry[] | null {
      try {
        return readdirSync(path, { withFileTypes: true }).map((d) => ({ name: d.name, kind: d.isFile() ? "file" : d.isDirectory() ? "dir" : "other" }));
      } catch {
        return null;
      }
    },
    include(configPath, pattern): IncludedFile[] {
      try {
        const base = realpathSync(dirname(configPath));
        const target = isAbsolute(pattern) ? pattern : resolve(base, pattern);
        const dir = dirname(target);
        const last = basename(target);
        if (/[*?]/.test(dir)) return []; // only the file name may be a pattern
        const realDir = realpathSync(dir);
        const inside = (p: string) => {
          const rel = relative(base, p);
          return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
        };
        if (realDir !== base && !inside(realDir)) return [];
        const names = /[*?]/.test(last) ? readdirSync(realDir).filter((n) => globToRegExp(last).test(n)).sort() : [last];
        const out: IncludedFile[] = [];
        for (const name of names.slice(0, MAX_INCLUDE_FILES)) {
          const full = join(realDir, name);
          let real: string;
          try {
            real = realpathSync(full);
          } catch {
            continue;
          }
          if (!inside(real)) continue; // a link that leaves the directory is not followed
          const data = readPrefix(real, MAX_INCLUDE_BYTES);
          if (data !== null) out.push({ path: real, text: data.toString("utf8") });
        }
        return out;
      } catch {
        return [];
      }
    },
    async agentList() {
      try {
        const { stdout } = await experimental_execHostFile("/usr/bin/ssh-add", ["-l"], { timeout: EXEC_TIMEOUT_MS, env: { PATH: "/usr/bin:/bin", ...(env.SSH_AUTH_SOCK !== undefined ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}) }, encoding: "utf8" });
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
        const { stdout } = await experimental_execHostFile("/usr/bin/ssh", ["-G", "-F", configPath, "--", alias], { timeout: EXEC_TIMEOUT_MS, env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
        return stdout;
      } catch {
        return null;
      }
    },
  };
}
