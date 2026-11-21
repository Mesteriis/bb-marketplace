import { describe, expect, it } from "vitest";
import { createTokenStore, generateVaultKey, isVaultKey, type KeyValue } from "./token-store.ts";

function memoryKv(): KeyValue & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    set: async (key, value) => void rows.set(key, value),
    delete: async (key) => void rows.delete(key),
  };
}

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // bytes 0..31
const OTHER_KEY = "Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA="; // bytes 31..0
const TOKENS = { accessToken: "access-plain", refreshToken: "refresh-plain", expiresAt: 1_700_000_000_000 };

describe("token store", () => {
  it("returns what was saved", async () => {
    const store = createTokenStore(memoryKv(), KEY);
    await store.save(TOKENS);
    expect(await store.load()).toEqual(TOKENS);
  });

  it("starts empty and is empty after clear", async () => {
    const store = createTokenStore(memoryKv(), KEY);
    expect(await store.load()).toBeNull();
    await store.save(TOKENS);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("keeps no token text in storage", async () => {
    const kv = memoryKv();
    await createTokenStore(kv, KEY).save(TOKENS);
    const raw = JSON.stringify([...kv.rows.values()]);
    expect(raw).not.toContain("access-plain");
    expect(raw).not.toContain("refresh-plain");
  });

  it("treats a record sealed with another key as no account", async () => {
    const kv = memoryKv();
    await createTokenStore(kv, KEY).save(TOKENS);
    expect(await createTokenStore(kv, OTHER_KEY).load()).toBeNull();
  });

  it("treats a tampered record as no account", async () => {
    const kv = memoryKv();
    await createTokenStore(kv, KEY).save(TOKENS);
    const sealed = kv.rows.get("tokens") as string;
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A=") ? "B=" : "A=");
    kv.rows.set("tokens", flipped);
    expect(await createTokenStore(kv, KEY).load()).toBeNull();
  });

  it("seals the same tokens differently each time", async () => {
    const kv = memoryKv();
    const store = createTokenStore(kv, KEY);
    await store.save(TOKENS);
    const first = kv.rows.get("tokens");
    await store.save(TOKENS);
    expect(kv.rows.get("tokens")).not.toBe(first);
  });
});

describe("vault key", () => {
  it("accepts 32 bytes of base64 only", () => {
    expect(isVaultKey(KEY)).toBe(true);
    expect(isVaultKey("AAEC")).toBe(false);
    expect(isVaultKey("")).toBe(false);
    expect(isVaultKey(generateVaultKey())).toBe(true);
  });

  it("refuses to build a store on a bad key", () => {
    expect(() => createTokenStore(memoryKv(), "AAEC")).toThrow("32 bytes");
  });
});
