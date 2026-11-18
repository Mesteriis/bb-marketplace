// SQLite storage for RDP certificates the user trusted for good (stage 3c-2). Host, port and the SHA-256
// fingerprint of a certificate: nothing secret and no certificate body.
import type Database from "better-sqlite3";
import type { PersistentRdpTrust, TrustedRdpCert } from "../../core/rdp-trust.ts";
import { normalizeFingerprint } from "../../core/rdp-trust.ts";

/** Appended after every earlier statement (see migrations.ts). */
export const RDP_TRUST_MIGRATIONS: string[] = [
  `CREATE TABLE rdp_trusted_certs (
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (host, port, fingerprint)
  );`,
];

interface Row {
  host: string;
  port: number;
  fingerprint: string;
  added_at: string;
}

export function createSqliteRdpTrust(db: Database.Database): PersistentRdpTrust {
  return {
    all(): TrustedRdpCert[] {
      const out: TrustedRdpCert[] = [];
      for (const row of db.prepare("SELECT * FROM rdp_trusted_certs ORDER BY added_at, rowid").all() as Row[]) {
        const fingerprint = normalizeFingerprint(row.fingerprint);
        if (fingerprint !== null) out.push({ host: row.host, port: row.port, fingerprint, addedAt: row.added_at });
      }
      return out;
    },
    add(cert) {
      db.prepare("INSERT OR IGNORE INTO rdp_trusted_certs (host, port, fingerprint, added_at) VALUES (?, ?, ?, ?)").run(cert.host, cert.port, cert.fingerprint, cert.addedAt);
    },
    remove(host, port, fingerprint) {
      return db.prepare("DELETE FROM rdp_trusted_certs WHERE host = ? AND port = ? AND fingerprint = ?").run(host, port, fingerprint).changes > 0;
    },
  };
}
