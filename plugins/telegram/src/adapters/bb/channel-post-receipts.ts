import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";

export type ChannelPostReceipts = {
  record(accountId: string, chatId: string, messageId: string, text: string): void;
  recent(accountId: string, chatId: string): string[];
  matches(accountId: string, chatId: string, messageId: string, text: string): boolean;
};

export const channelPostReceiptMigrations = [`CREATE TABLE telegram_channel_post_receipts (
    account_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    PRIMARY KEY (account_id, chat_id, message_id)
  )`];

export function createChannelPostReceipts(db: Database.Database, sessionKey: string): ChannelPostReceipts {
  const write = db.prepare("INSERT OR IGNORE INTO telegram_channel_post_receipts VALUES (?, ?, ?, ?)");
  const read = db.prepare("SELECT 1 FROM telegram_channel_post_receipts WHERE account_id = ? AND chat_id = ? AND message_id = ? AND digest = ?");
  const recent = db.prepare<[string, string], { message_id: string }>(`SELECT message_id FROM telegram_channel_post_receipts
    WHERE account_id = ? AND chat_id = ? ORDER BY CAST(message_id AS INTEGER) DESC LIMIT 25`);
  const digest = (accountId: string, chatId: string, messageId: string, text: string) =>
    createHmac("sha256", Buffer.from(sessionKey, "base64"))
      .update(JSON.stringify([accountId, chatId, messageId, text])).digest("hex");
  return {
    record: (accountId, chatId, messageId, text) => { write.run(accountId, chatId, messageId, digest(accountId, chatId, messageId, text)); },
    recent: (accountId, chatId) => recent.all(accountId, chatId).map((row) => row.message_id),
    matches: (accountId, chatId, messageId, text) => !!read.get(accountId, chatId, messageId, digest(accountId, chatId, messageId, text)),
  };
}
