import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_spawnHostProcess } from "@get-bb/plugin-sdk/process";
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { EndpointId } from "../../core/model.ts";
import type { JobStore } from "../../core/job-store.ts";
import type { FileProvider } from "../../core/provider.ts";
import { ArchiveHelperClient, type HelperProcess } from "./archive-helper.ts";
import { checkHelperIntegrity } from "./archive-helper-integrity.ts";
import { createArchiveDirs } from "./archive-dirs.ts";
import { createArchiveManager } from "./archive-manager.ts";
import { createPasswordGate } from "./archive-password.ts";
import { createArchiveRegistry } from "./archive-registry.ts";

export const HELPER_VERSION = "0.1.0";
const RSS_LIMIT = 512 * 1024 * 1024;
const PURGE_EVERY_MS = 60 * 60 * 1000;

function psRss(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "rss=", "-p", String(pid)], { timeout: 2000, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } }, (error, stdout) => {
      const kib = Number(stdout.trim());
      resolve(error || !Number.isFinite(kib) || kib <= 0 ? null : kib * 1024);
    });
  });
}

/** Everything the archive feature needs at runtime, built once in server.ts. */
export function createArchiveRuntime(deps: {
  bb: BbPluginApi;
  db: Database.Database;
  jobs: JobStore;
  kv: PluginKvStorage;
  sourceProvider(endpoint: EndpointId): FileProvider;
  publishPassword(archiveId: string): void;
}) {
  const { bb } = deps;
  const registry = createArchiveRegistry({ db: deps.db, jobs: deps.jobs });
  const gate = createPasswordGate({ publish: deps.publishPassword, timeoutMs: 5 * 60_000 });
  let binPath: string | null = null;
  let dirs: ReturnType<typeof createArchiveDirs> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const manager = createArchiveManager({
    registry,
    get dirs() {
      if (!dirs) throw new Error("Archive directories are not ready");
      return dirs;
    },
    sourceProvider: deps.sourceProvider,
    createHelper: () => new ArchiveHelperClient({
      binPath: binPath ?? "",
      helperVersion: HELPER_VERSION,
      platform: process.platform,
      arch: process.arch,
      spawn: (command, args, options) => experimental_spawnHostProcess(command, args, { env: options.env }) as unknown as HelperProcess,
      integrity: checkHelperIntegrity,
      rssLimitBytes: RSS_LIMIT,
      readRss: psRss,
    }),
    freeBytes: async (dir) => {
      const stat = await statfs(dir);
      return BigInt(stat.bavail) * BigInt(stat.bsize);
    },
    askPassword: (id) => gate.ask(id),
  });

  return {
    manager, registry, gate,
    /** Finds the plugin's directory (for the helper binary), prepares the private work directories and cleans up. */
    async init(signal: AbortSignal) {
      const installed = await bb.sdk.plugins.list();
      const root = installed.plugins.find((entry) => entry.id === bb.pluginId)?.rootDir;
      binPath = root ? join(root, "bin", "commander-archive-helper") : null;
      const saved = await deps.kv.get("archive-install-id");
      let installId = typeof saved === "string" && /^[0-9a-f-]{36}$/.test(saved) ? saved : null;
      if (installId === null) {
        installId = randomUUID();
        await deps.kv.set("archive-install-id", installId);
      }
      dirs = createArchiveDirs({ tmpdir: tmpdir(), installId, pid: process.pid, uid: process.getuid?.() ?? 0 });
      await dirs.init();
      await registry.purge();
      if (signal.aborted) return;
      timer = setInterval(() => void registry.purge().catch(() => undefined), PURGE_EVERY_MS);
      timer.unref?.();
    },
    async dispose() {
      if (timer) clearInterval(timer);
      await manager.closeAll();
      await dirs?.dispose();
    },
  };
}

export type ArchiveRuntime = ReturnType<typeof createArchiveRuntime>;
