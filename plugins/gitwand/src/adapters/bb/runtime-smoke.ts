// The check a downloaded runtime must pass before it becomes current: it
// starts, reports the promised version, and reads the status of a fresh
// repository with one modified file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeProcess, type SpawnBridge } from "./bridge-process.ts";
import type { InstalledRuntime } from "./runtime-store.ts";

export async function smokeRuntime(runtime: InstalledRuntime, options: { spawn: SpawnBridge; env: NodeJS.ProcessEnv }): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "gitwand-smoke-"));
  let bridge: BridgeProcess | null = null;
  try {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=smoke@example.invalid", "-c", "user.name=smoke", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(repo, "smoke.txt"), "1\n");
    git("add", ".");
    git("commit", "-qm", "smoke");
    writeFileSync(join(repo, "smoke.txt"), "2\n");
    bridge = await BridgeProcess.start({ bin: runtime.bin, env: options.env, spawn: options.spawn });
    if (bridge.hello.runtime !== runtime.version) throw new Error(`candidate answered ${bridge.hello.runtime}, expected ${runtime.version}`);
    const status = await bridge.call("git_status", { cwd: repo });
    const unstaged = status.ok ? ((status.value as { unstaged?: { path: string }[] }).unstaged ?? []) : [];
    if (!unstaged.some((f) => f.path === "smoke.txt")) throw new Error("git_status did not report smoke.txt");
  } finally {
    await bridge?.stop(1000);
    rmSync(repo, { recursive: true, force: true });
  }
}
