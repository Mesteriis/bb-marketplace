// The plugin refuses a helper whose version is not the one it was built for. Three places state that version and a
// release that moves one of them alone ships a helper the plugin will not start (0.2.0 did exactly that).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { HELPER_VERSION, helperBinaryPath, probeHelper } from "./helper-process.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the helper version the plugin expects is the crate's version and the package's version", () => {
  const cargo = /^version = "([^"]+)"/m.exec(readFileSync(join(root, "helper", "Cargo.toml"), "utf8"))?.[1];
  const pkg = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  expect(cargo).toBe("0.2.1");
  expect(pkg).toBe("0.2.1");
  expect(HELPER_VERSION).toBe("0.2.1");
});

test.skipIf(!existsSync(join(root, "bin", "remote-hub-helper")))("the shipped helper binary passes the plugin's own start check (checksum and version)", async () => {
  const probe = await probeHelper(helperBinaryPath(root));
  expect(probe).toMatchObject({ ok: true });
});
