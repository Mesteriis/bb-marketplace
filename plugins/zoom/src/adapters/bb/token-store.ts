// Keeps the Zoom tokens in the plugin's key-value storage, sealed with
// AES-256-GCM under the vaultKey setting. Format: "v1:" + base64(iv[12] |
// tag[16] | ciphertext). A record that cannot be opened counts as "no account".
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { StoredTokens, TokenStore } from "../../core/ports.ts";

const PREFIX = "v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STORAGE_KEY = "tokens";

/** The part of bb.storage.kv this adapter uses. */
export interface KeyValue {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function generateVaultKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function isVaultKey(value: string): boolean {
  return Buffer.from(value, "base64").length === KEY_BYTES;
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accessToken === "string" &&
    typeof record.refreshToken === "string" &&
    typeof record.expiresAt === "number"
  );
}

export function createTokenStore(kv: KeyValue, keyBase64: string): TokenStore {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) throw new Error("Vault key must be 32 bytes (base64)");

  function open(sealed: unknown): StoredTokens | null {
    if (typeof sealed !== "string" || !sealed.startsWith(PREFIX)) return null;
    const bytes = Buffer.from(sealed.slice(PREFIX.length), "base64");
    if (bytes.length <= IV_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
      decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
      const value: unknown = JSON.parse(plain.toString("utf8"));
      return isStoredTokens(value) ? value : null;
    } catch {
      return null;
    }
  }

  return {
    async load() {
      return open(await kv.get<unknown>(STORAGE_KEY));
    },
    async save(tokens) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
      await kv.set(STORAGE_KEY, PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64"));
    },
    async clear() {
      await kv.delete(STORAGE_KEY);
    },
  };
}
