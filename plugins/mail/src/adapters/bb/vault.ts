// Seals account passwords with AES-256-GCM under the plugin's vaultKey
// setting. Format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretVault } from "../../core/index.ts";

const PREFIX = "v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function generateVaultKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function createVault(keyBase64: string): SecretVault {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) throw new Error("Vault key must be 32 bytes (base64)");
  return {
    seal(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    },
    open(sealed) {
      try {
        if (!sealed.startsWith(PREFIX)) throw new Error("unknown format");
        const bytes = Buffer.from(sealed.slice(PREFIX.length), "base64");
        if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("too short");
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
        decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([
          decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("Cannot decrypt credential");
      }
    },
  };
}
