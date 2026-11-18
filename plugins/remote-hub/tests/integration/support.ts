// Shared setup for every integration file that saves a credential (Z4). A production helper ignores the temporary
// Keychain path and would write to the REAL login keychain, so the binary is checked BEFORE anything else starts, and the
// throwaway Keychain environment and temp directories come from one place and are removed from one place.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/** Throws unless `helperPath` is a test-hooks build (the one that honours REMOTE_HUB_KEYCHAIN_PATH). */
export function assertTestHooksHelper(helperPath: string): void {
  if (!readFileSync(helperPath).includes("REMOTE_HUB_KEYCHAIN_PATH")) {
    throw new Error("REMOTE_HUB_HELPER is not a test-hooks build: build it with cargo build --features test-hooks (a production helper would use the real Keychain)");
  }
}

/** A fresh temp directory, removed by `removeTemps`. */
export function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function removeTemps(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The environment that points a test-hooks helper at a throwaway Keychain and overlay inside `dir`. */
export function throwawayEnv(dir: string): Record<string, string> {
  return {
    REMOTE_HUB_KEYCHAIN_PATH: join(dir, "kc.keychain-db"),
    REMOTE_HUB_KEYCHAIN_CREATE_PASSWORD: "throwaway-kc-password",
    REMOTE_HUB_TEST_ALLOW_KNOWN_HOSTS: "1",
    REMOTE_HUB_KNOWN_HOSTS_PATH: join(dir, "Application Support", "Remote Hub", "known_hosts"),
  };
}
