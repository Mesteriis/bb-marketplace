// Seals connection credentials with AES-256-GCM under the plugin's vaultKey
// setting. Format: "v1:" + base64(iv[12] | tag[16] | ciphertext). The plain
// secret is returned only to build an Authorization header; it is never sent
// to the frontend.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { CredentialStore } from "../../core/ports.ts";

const PREFIX = "v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function generateVaultKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function isVaultKey(value: string): boolean {
  try {
    return Buffer.from(value, "base64").length === KEY_BYTES;
  } catch {
    return false;
  }
}

export function createCredentialStore(db: Database.Database, keyBase64: string): CredentialStore {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) throw new Error("Vault key must be 32 bytes (base64)");

  const insert = db.prepare(
    "INSERT INTO credentials (connection_id, sealed) VALUES (?, ?) ON CONFLICT(connection_id) DO UPDATE SET sealed = excluded.sealed",
  );
  const select = db.prepare("SELECT sealed FROM credentials WHERE connection_id = ?");
  const remove = db.prepare("DELETE FROM credentials WHERE connection_id = ?");

  return {
    put(connectionId, secret) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      insert.run(connectionId, PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64"));
    },
    get(connectionId) {
      const row = select.get(connectionId) as { sealed: string } | undefined;
      if (row === undefined || !row.sealed.startsWith(PREFIX)) return null;
      try {
        const bytes = Buffer.from(row.sealed.slice(PREFIX.length), "base64");
        if (bytes.length < IV_BYTES + TAG_BYTES) return null;
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
        decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
    delete(connectionId) {
      remove.run(connectionId);
    },
  };
}
