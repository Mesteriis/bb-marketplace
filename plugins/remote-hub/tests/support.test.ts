import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertTestHooksHelper, makeTemp, removeTemps, throwawayEnv } from "./integration/support.ts";

afterAll(removeTemps);

describe("the shared integration setup (Z4)", () => {
  it("refuses a helper that does not honour the temporary Keychain path, and accepts one that does", () => {
    const dir = makeTemp("rh-support-");
    const production = join(dir, "production-helper");
    const hooks = join(dir, "hooks-helper");
    writeFileSync(production, "ELF-ish bytes without the hook name");
    writeFileSync(hooks, "bytes REMOTE_HUB_KEYCHAIN_PATH more bytes");
    expect(() => assertTestHooksHelper(production)).toThrow(/not a test-hooks build/);
    expect(() => assertTestHooksHelper(hooks)).not.toThrow();
  });

  it("points the Keychain and the overlay inside the given directory", () => {
    const env = throwawayEnv("/tmp/x");
    expect(env.REMOTE_HUB_KEYCHAIN_PATH).toBe("/tmp/x/kc.keychain-db");
    expect(env.REMOTE_HUB_KNOWN_HOSTS_PATH).toBe("/tmp/x/Application Support/Remote Hub/known_hosts");
  });
});
