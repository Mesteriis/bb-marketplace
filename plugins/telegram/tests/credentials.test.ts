import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readCredentials } from "../src/adapters/bb/credentials.ts";

test("reads a private Makosh credential file and rejects public files and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "makosh-credentials-test-"));
  try {
    const file = join(root, "app.env");
    const alias = join(root, "alias.env");
    const fakeHash = "0".repeat(32);
    writeFileSync(file, `MAKOSH_TELEGRAM_API_ID=123\nMAKOSH_TELEGRAM_API_HASH=${fakeHash}\n`, { mode: 0o600 });
    expect(readCredentials(file)).toEqual({ apiId: 123, apiHash: fakeHash });
    symlinkSync(file, alias);
    expect(() => readCredentials(alias)).toThrow();
    chmodSync(file, 0o644);
    expect(() => readCredentials(file)).toThrow("Invalid Telegram credential file permissions");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
