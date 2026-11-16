import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createCredentialStore, generateVaultKey, isVaultKey } from "./credential-store.ts";
import { MIGRATIONS } from "./sqlite-store.ts";

function makeStore(keyBase64: string) {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  return createCredentialStore(db, keyBase64);
}

describe("credential store", () => {
  it("seals and opens a secret", () => {
    const key = generateVaultKey();
    const store = makeStore(key);
    store.put("j1", "super-secret-token");
    expect(store.get("j1")).toBe("super-secret-token");
  });

  it("returns null for a missing or deleted secret", () => {
    const store = makeStore(generateVaultKey());
    expect(store.get("j1")).toBeNull();
    store.put("j1", "tok");
    store.delete("j1");
    expect(store.get("j1")).toBeNull();
  });

  it("returns null when opened with a different key", () => {
    const first = generateVaultKey();
    const store = makeStore(first);
    store.put("j1", "tok");
    const second = makeStore(generateVaultKey());
    expect(second.get("j1")).toBeNull();
  });

  it("validates vault keys", () => {
    expect(isVaultKey(generateVaultKey())).toBe(true);
    expect(isVaultKey("not-base64")).toBe(false);
  });
});
