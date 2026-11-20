import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { Message } from "../../core/demo.ts";

type Cause = NonNullable<Message["retained"]>;
type Row = { message_id: number; snapshot: Buffer; retained: Cause; has_media: number };

export const privateHistoryMigration = `CREATE TABLE telegram_private_history (
  account TEXT NOT NULL,
  chat TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  snapshot BLOB NOT NULL,
  retained TEXT CHECK (retained IN ('deleted','expired')),
  PRIMARY KEY (account, chat, message_id)
)`;

export const privateMediaMigration = "ALTER TABLE telegram_private_history ADD COLUMN media BLOB";

export type PrivateMediaMime = "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "video/webm";

export function createPrivateHistory(db: Database.Database, sessionKey: string) {
  const key = Buffer.from(sessionKey, "base64");
  const save = db.prepare(`INSERT INTO telegram_private_history (account, chat, message_id, snapshot) VALUES (?, ?, ?, ?)
    ON CONFLICT(account, chat, message_id) DO UPDATE SET snapshot = excluded.snapshot WHERE retained IS NULL AND media IS NULL`);
  const mark = db.prepare(`UPDATE telegram_private_history SET retained = COALESCE(retained, ?)
    WHERE account = ? AND chat = ? AND message_id = ?`);
  const remove = db.prepare("DELETE FROM telegram_private_history WHERE account = ? AND chat = ? AND message_id = ?");
  const scan = db.prepare<[string, string, number], Pick<Row, "message_id" | "snapshot">>(`
    SELECT message_id, snapshot FROM telegram_private_history WHERE account = ? AND chat = ? AND message_id > ?
    ORDER BY message_id LIMIT 256
  `);
  const purge = db.prepare("DELETE FROM telegram_private_history WHERE account = ?");
  const read = db.prepare<[string, string, number, number], Row>(`
    SELECT message_id, snapshot, retained, media IS NOT NULL AS has_media FROM telegram_private_history
    WHERE account = ? AND chat = ? AND message_id < ? AND message_id >= ? AND retained IS NOT NULL
    ORDER BY message_id DESC LIMIT 50
  `);
  const byId = db.prepare<[string, string, number], Row>(`SELECT message_id, snapshot, retained, media IS NOT NULL AS has_media FROM telegram_private_history
    WHERE account = ? AND chat = ? AND message_id = ? AND retained IS NOT NULL`);
  const writeMedia = db.prepare(`UPDATE telegram_private_history SET media = ?
    WHERE account = ? AND chat = ? AND message_id = ? AND retained IS NULL`);
  const readMedia = db.prepare<[string, string, number], { media: Buffer }>(`SELECT media FROM telegram_private_history
    WHERE account = ? AND chat = ? AND message_id = ? AND retained IS NOT NULL AND media IS NOT NULL`);
  const aad = (account: string, chat: string, id: string) => Buffer.from(JSON.stringify([account, chat, id]));
  function seal(data: Buffer, context: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(context);
    return Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  }
  function unseal(data: Buffer, context: Buffer): Buffer {
    const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    cipher.setAAD(context);
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]);
  }
  function open(account: string, chat: string, { message_id, snapshot, retained, has_media }: Row): Message {
    const message: Message = JSON.parse(unseal(snapshot, aad(account, chat, String(message_id))).toString("utf8"));
    if (!has_media) delete message.oneView;
    return { ...message, retained };
  }
  const mediaTypes: readonly PrivateMediaMime[] = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"];
  const saveMessages = db.transaction((account: string, chat: string, messages: Message[]) => {
    for (const message of messages) {
      const snapshot = seal(Buffer.from(JSON.stringify(message)), aad(account, chat, message.id));
      save.run(account, chat, Number(message.id), snapshot);
    }
  });
  return {
    save: saveMessages,
    stageMedia: db.transaction((account: string, chat: string, message: Message, mime: PrivateMediaMime, bytes: Buffer) => {
      saveMessages(account, chat, [message]);
      const data = Buffer.concat([Buffer.from([mediaTypes.indexOf(mime)]), bytes]);
      const result = writeMedia.run(seal(data, aad(account, chat, `media:${message.id}`)), account, chat, Number(message.id));
      if (!result.changes) throw new Error("One-view media has already expired.");
    }),
    discardMedia(account: string, chat: string, id: string) {
      writeMedia.run(null, account, chat, Number(id));
    },
    media(account: string, chat: string, id: string) {
      const row = readMedia.get(account, chat, Number(id));
      if (!row) return;
      const data = unseal(row.media, aad(account, chat, `media:${id}`));
      const mime = mediaTypes[data[0]!];
      if (!mime || data.length < 2) throw new Error("Invalid local Telegram media.");
      return { bytes: data.subarray(1), mime };
    },
    mark(account: string, chat: string, id: string, cause: Cause) {
      mark.run(cause, account, chat, Number(id));
      const row = byId.get(account, chat, Number(id));
      return row && open(account, chat, row);
    },
    remove: (account: string, chat: string, id: string) => { remove.run(account, chat, Number(id)); },
    removeDateRange: db.transaction((account: string, chat: string, start: number, end: number) => {
      const ids: string[] = [];
      let cursor = 0;
      for (;;) {
        const rows = scan.all(account, chat, cursor);
        if (!rows.length) break;
        for (const { message_id, snapshot } of rows) {
          const id = String(message_id);
          const copy: Message = JSON.parse(unseal(snapshot, aad(account, chat, id)).toString("utf8"));
          if (typeof copy.timestamp === "number" && copy.timestamp >= start && copy.timestamp <= end) {
            remove.run(account, chat, message_id);
            ids.push(id);
          }
          cursor = message_id;
        }
      }
      return ids;
    }),
    purge: (account: string) => { purge.run(account); },
    page(account: string, chat: string, before: number, floor: number): Message[] {
      return read.all(account, chat, before || Number.MAX_SAFE_INTEGER + 1, floor).map((row) => open(account, chat, row));
    },
  };
}
