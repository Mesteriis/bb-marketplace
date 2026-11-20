import type Database from "better-sqlite3";
import { maxMiniAppDeviceStorageBytes, type MiniAppDeviceStorageOperation, type MiniAppLocationDecision } from "../../core/contract.ts";

export const miniAppDeviceStorageMigration = `CREATE TABLE telegram_mini_app_device_storage (
  account_id TEXT NOT NULL,
  bot_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (account_id, bot_id, key)
)`;

export function createMiniAppDeviceStorage(db: Database.Database) {
  const read = db.prepare<[string, number, string], { value: string }>(
    "SELECT value FROM telegram_mini_app_device_storage WHERE account_id = ? AND bot_id = ? AND key = ?");
  const used = db.prepare<[string, number, string], { bytes: number }>(
    "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM telegram_mini_app_device_storage WHERE account_id = ? AND bot_id = ? AND key <> ?");
  const save = db.prepare(`INSERT INTO telegram_mini_app_device_storage VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (account_id, bot_id, key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes`);
  const remove = db.prepare("DELETE FROM telegram_mini_app_device_storage WHERE account_id = ? AND bot_id = ? AND key = ?");
  const clear = db.prepare("DELETE FROM telegram_mini_app_device_storage WHERE account_id = ? AND bot_id = ?");
  const saveWithinQuota = db.transaction((account: string, bot: number, key: string, value: string) => {
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (bytes > maxMiniAppDeviceStorageBytes || (used.get(account, bot, key)?.bytes ?? 0) + bytes > maxMiniAppDeviceStorageBytes) return false;
    save.run(account, bot, key, JSON.stringify(value), bytes);
    return true;
  });
  return (account: string, bot: number, operation: MiniAppDeviceStorageOperation) => {
    let value: string | null = null;
    switch (operation.kind) {
      case "get": {
        const row = read.get(account, bot, operation.key);
        if (row) value = JSON.parse(row.value);
        break;
      }
      case "save":
        if (operation.value === null) remove.run(account, bot, operation.key);
        else if (!saveWithinQuota.immediate(account, bot, operation.key, operation.value)) {
          return { status: "failed" as const, error: "QUOTA_EXCEEDED" as const };
        }
        break;
      case "clear":
        clear.run(account, bot);
        break;
    }
    return { status: "ok" as const, value };
  };
}

export const miniAppLocationAccessMigration = `CREATE TABLE telegram_mini_app_location_access (
  account_id TEXT NOT NULL,
  bot_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
  PRIMARY KEY (account_id, bot_id)
)`;

export function createMiniAppLocationAccess(db: Database.Database) {
  const read = db.prepare<[string, number], { decision: "allowed" | "denied" }>(
    "SELECT decision FROM telegram_mini_app_location_access WHERE account_id = ? AND bot_id = ?");
  const write = db.prepare(`INSERT INTO telegram_mini_app_location_access VALUES (?, ?, ?)
    ON CONFLICT (account_id, bot_id) DO UPDATE SET decision = excluded.decision`);
  const reset = db.prepare("DELETE FROM telegram_mini_app_location_access WHERE account_id = ? AND bot_id = ?");
  return (account: string, bot: number, decision?: MiniAppLocationDecision): MiniAppLocationDecision => {
    if (decision === "ask") reset.run(account, bot);
    else if (decision) write.run(account, bot, decision);
    return decision ?? read.get(account, bot)?.decision ?? "ask";
  };
}
