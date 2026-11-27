import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import type { Database } from "better-sqlite3";

type VaultDatabase = Pick<Database, "prepare">;

export const migrations = [
  `CREATE TABLE credential_vault (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    account TEXT NOT NULL,
    seal BLOB
  )`,
  `CREATE TABLE credential_secrets (
    plugin_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (plugin_id, ref)
  )`,
];

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const algorithm = "aes-256-gcm";

function encrypt(key: Buffer, context: string, plaintext: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(algorithm, key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decrypt(key: Buffer, context: string, value: Uint8Array): string {
  try {
    const decipher = createDecipheriv(algorithm, key, value.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(value.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(value.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Vault authentication failed");
  }
}

export function vaultMetadata(db: VaultDatabase): { account: string; seal: Uint8Array | null } {
  db.prepare<[string]>("INSERT OR IGNORE INTO credential_vault (singleton, account) VALUES (1, ?)").run(randomUUID());
  return db.prepare("SELECT account, seal FROM credential_vault WHERE singleton = 1").get() as {
    account: string;
    seal: Uint8Array | null;
  };
}

export function openVault(db: VaultDatabase, key: Buffer) {
  const { account } = vaultMetadata(db);
  db.prepare<[Buffer]>("UPDATE credential_vault SET seal = ? WHERE singleton = 1 AND seal IS NULL").run(
    encrypt(key, account, "credential-vault/v1"),
  );
  const { seal } = vaultMetadata(db);
  if (!seal || decrypt(key, account, seal) !== "credential-vault/v1") throw new Error("Vault authentication failed");

  const upsert = db.prepare<[string, string, Buffer]>(`INSERT INTO credential_secrets (plugin_id, ref, value) VALUES (?, ?, ?)
    ON CONFLICT (plugin_id, ref) DO UPDATE SET value = excluded.value`);
  const insert = db.prepare<[string, string, Buffer]>(`INSERT INTO credential_secrets (plugin_id, ref, value)
    VALUES (?, ?, ?) ON CONFLICT (plugin_id, ref) DO NOTHING`);
  const select = db.prepare<[string, string]>("SELECT value FROM credential_secrets WHERE plugin_id = ? AND ref = ?");
  const remove = db.prepare<[string, string]>("DELETE FROM credential_secrets WHERE plugin_id = ? AND ref = ?");
  const context = (pluginId: string, ref: string) => JSON.stringify([account, pluginId, ref]);

  return {
    put(pluginId: string, ref: string, secret: string): void {
      upsert.run(pluginId, ref, encrypt(key, context(pluginId, ref), secret));
    },
    putIfAbsent(pluginId: string, ref: string, secret: string): boolean {
      return insert.run(pluginId, ref, encrypt(key, context(pluginId, ref), secret)).changes === 1;
    },
    get(pluginId: string, ref: string): string | null {
      const row = select.get(pluginId, ref) as { value: Uint8Array } | undefined | null;
      return row ? decrypt(key, context(pluginId, ref), row.value) : null;
    },
    remove(pluginId: string, ref: string): boolean {
      return remove.run(pluginId, ref).changes === 1;
    },
  };
}
