import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrations, openVault } from "../src/adapters/bb/vault.ts";
import { callerNamespace } from "../src/core/access.ts";

function fixture() {
  const db = new Database(":memory:");
  for (const migration of migrations) db.exec(migration);
  const key = Buffer.alloc(32, 19);
  return { db, key, vault: openVault(db, key) };
}

describe("credential vault", () => {
  test("uses the host's caller identity and rejects frontend calls", () => {
    expect(callerNamespace({ kind: "plugin", pluginId: "makosh-remote-hub" })).toBe("makosh-remote-hub");
    expect(() => callerNamespace({ kind: "client" })).toThrow("Plugin backend required");
  });

  test("stores ciphertext and separates two plugins with the same reference", () => {
    const { db, vault } = fixture();
    vault.put("plugin-a", "login", "fake password 🔒");
    vault.put("plugin-b", "login", "other fake password");
    expect(vault.get("plugin-a", "login")).toBe("fake password 🔒");
    expect(vault.get("plugin-b", "login")).toBe("other fake password");
    const row = db.query("SELECT value FROM credential_secrets WHERE plugin_id = 'plugin-a'").get() as { value: Uint8Array };
    expect(Buffer.from(row.value).includes("fake password")).toBe(false);
    expect(vault.remove("plugin-a", "login")).toBe(true);
    expect(vault.get("plugin-a", "login")).toBeNull();
    expect(vault.get("plugin-b", "login")).toBe("other fake password");
    db.close();
  });

  test("rejects copying an encrypted secret to a different reference", () => {
    const { db, vault } = fixture();
    vault.put("plugin-a", "login", "fixture");
    db.exec("UPDATE credential_secrets SET ref = 'copied'");
    expect(() => vault.get("plugin-a", "copied")).toThrow("Vault authentication failed");
    db.close();
  });

  test("rejects a replacement master key even after all secrets were removed", () => {
    const { db, vault } = fixture();
    vault.put("plugin-a", "login", "fixture");
    vault.remove("plugin-a", "login");
    expect(() => openVault(db, Buffer.alloc(32, 20))).toThrow("Vault authentication failed");
    db.close();
  });
});
