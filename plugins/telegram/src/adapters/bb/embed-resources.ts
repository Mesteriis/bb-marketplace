import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const embedMigration = `CREATE TABLE telegram_embed_resources (
  account TEXT NOT NULL, id TEXT NOT NULL, topic INTEGER NOT NULL, ref TEXT NOT NULL UNIQUE,
  PRIMARY KEY (account,id,topic)
)`;
export function embedResources(db: Database.Database) {
  const byTarget = db.prepare<[string,string,number],{ref:string}>("SELECT ref FROM telegram_embed_resources WHERE account=? AND id=? AND topic=?");
  const byRef = db.prepare<[string,string],{id:string;topic:number}>("SELECT id,topic FROM telegram_embed_resources WHERE account=? AND ref=?");
  const insert = db.prepare("INSERT INTO telegram_embed_resources VALUES (?,?,?,?)");
  const bind = db.transaction((account: string, id: string, topicId = 0) => {
    const existing = byTarget.get(account, id, topicId);
    if (existing) return existing.ref;
    const ref = randomUUID();
    insert.run(account, id, topicId, ref);
    return ref;
  });
  return { bind: bind.immediate, resolve(account: string, ref: string) {
    const row = byRef.get(account, ref);
    return row && { id: row.id, ...(row.topic && { topicId: row.topic }) };
  } };
}
