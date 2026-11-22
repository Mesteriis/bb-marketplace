// Installs the Account Pooler model bridge when it is missing, for example
// after a BB update replaced the patched built-in plugin. Account Pooler ships
// inside bb-app; its built server.js is patched in place (the original is kept
// next to it as server.js.orig) and the plugin is reloaded. A signed
// application bundle is never modified.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { patchAccountPool } from "../../core/pool-patch.js";

export type ProbeResult = "present" | "bridge_missing" | "pool_missing";
export type SelfInstallOutcome =
  | { status: "present" }
  | { status: "installed"; file: string }
  | { status: "pool_missing" }
  | { status: "skipped"; reason: string };

export interface SelfInstallDeps {
  probe(): Promise<ProbeResult>;
  /** Entry script of the process running this plugin: the BB server or a plugin host worker. */
  hostEntry: string | undefined;
  bundle: string;
  files: {
    exists(path: string): boolean;
    read(path: string): string;
    writeAtomic(path: string, text: string): void;
    copyIfMissing(from: string, to: string): void;
  };
  reload(): Promise<void>;
  wait(ms: number): Promise<void>;
  log(message: string): void;
}

const POOL_SERVER = join("server", "dist", "builtin-plugins", "account-pool", "dist", "server.js");
const SIGNED_BUNDLE = /\.app\/Contents\//;

/** Possible Account Pooler server files, from the host entry up to the filesystem root. */
export function poolServerCandidates(hostEntry: string): string[] {
  const candidates: string[] = [];
  let dir = dirname(hostEntry);
  for (let depth = 0; depth < 8; depth++) {
    candidates.push(join(dir, POOL_SERVER));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

async function probeAfterReload(deps: SelfInstallDeps): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await deps.probe() === "present") return true;
    await deps.wait(1_000);
  }
  return false;
}

export async function ensurePoolBridge(deps: SelfInstallDeps): Promise<SelfInstallOutcome> {
  const state = await deps.probe();
  if (state === "present") return { status: "present" };
  if (state === "pool_missing") return { status: "pool_missing" };

  const file = deps.hostEntry === undefined ? undefined
    : poolServerCandidates(deps.hostEntry).find((path) => deps.files.exists(path));
  if (file === undefined) return { status: "skipped", reason: "not_found" };
  if (SIGNED_BUNDLE.test(file)) return { status: "skipped", reason: "signed_bundle" };

  const result = patchAccountPool(deps.files.read(file), deps.bundle);
  if (result.kind === "refused") return { status: "skipped", reason: `refused:${result.reason}` };
  if (result.kind === "patched") {
    deps.files.copyIfMissing(file, `${file}.orig`);
    deps.files.writeAtomic(file, result.source);
    deps.log(`Account Pooler bridge written to ${file}`);
  }
  await deps.reload();
  if (!await probeAfterReload(deps)) return { status: "skipped", reason: "still_missing" };
  deps.log("Account Pooler bridge is active");
  return { status: "installed", file };
}

export const nodeFiles: SelfInstallDeps["files"] = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, "utf8"),
  writeAtomic(path, text) {
    const temporary = `${path}.makosh-${process.pid}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  },
  copyIfMissing(from, to) {
    if (!existsSync(to)) copyFileSync(from, to);
  },
};
