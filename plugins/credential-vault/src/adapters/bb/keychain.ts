import { existsSync } from "node:fs";
import { join } from "node:path";
import { experimental_spawnHostProcess } from "@get-bb/plugin-sdk/process";

export type KeyState = "missing" | "approval" | "no_keychain" | "locked" | "unavailable";
type KeyResult = { key: Buffer } | { state: KeyState; detail?: string };

const exitStates = new Map<number, KeyState>([
  [10, "missing"],
  [11, "approval"],
  [12, "no_keychain"],
  [14, "locked"],
]);

export function readKey(
  pluginRoot: string,
  account: string,
  mode: "read" | "create" | "approve",
  signal: AbortSignal,
): Promise<KeyResult> {
  if (process.platform !== "darwin" || signal.aborted) return Promise.resolve({ state: "unavailable" });
  const helper = join(pluginRoot, "bin", "vault-key");
  if (!existsSync(helper)) return Promise.resolve({ state: "unavailable", detail: "helper_missing" });

  return new Promise((resolve) => {
    const child = experimental_spawnHostProcess(helper, [mode, account], {
      signal,
      timeout: mode === "approve" ? 60_000 : 5_000,
      killSignal: "SIGKILL",
    });
    child.stdin.end();
    child.stderr.resume();
    const bytes = Buffer.alloc(32);
    let count = 0;
    let spawnFailed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (count + chunk.length <= bytes.length) chunk.copy(bytes, count);
      count += chunk.length;
      chunk.fill(0);
      if (count > bytes.length) child.kill("SIGKILL");
    });
    child.once("error", () => {
      spawnFailed = true;
      child.kill("SIGKILL");
    });
    child.once("close", (code) => {
      if (code === 0 && !signal.aborted && count === bytes.length) {
        resolve({ key: bytes });
        return;
      }
      bytes.fill(0);
      const state = exitStates.get(code ?? -1) ?? "unavailable";
      resolve(state === "unavailable" ? { state, detail: spawnFailed ? "spawn_failed" : `helper_exit_${code}` } : { state });
    });
  });
}
