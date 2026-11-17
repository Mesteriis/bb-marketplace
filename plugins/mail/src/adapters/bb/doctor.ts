// `bb makosh-mail doctor` and `backup` (slice 3j, #75 and part of #94): the
// owner's own checks of an account and of the plugin's database, from their
// terminal. Every line is fixed text with counts, codes and the account's
// own address: never a password, a server reply, a subject or a sender.
import { chmod, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { imapConfigOf } from "../../core/compose.ts";
import { smtpConfigOf } from "../../core/compose-outbox.ts";
import type { ImapGateway, MailStore, MailTransport, SecretVault } from "../../core/ports.ts";
import { SendError } from "../../core/ports.ts";
import { parseSyncProblems, syncProblemText } from "../../core/sync-problems.ts";

export type DoctorLevel = "ok" | "warn" | "fail";
export type DoctorLine = { level: DoctorLevel; check: string; text: string };
export type DoctorSection = { accountId: string | null; title: string; lines: DoctorLine[] };

export type DoctorDeps = {
  store: MailStore;
  gateway: ImapGateway;
  transport: MailTransport;
  /** Null while the credential key is not set. */
  vault: SecretVault | null;
  /** Runs work for an account behind its sync and its writes. */
  run: <T>(accountId: string, work: () => Promise<T>) => Promise<T>;
  db: Database.Database;
  now: () => Date;
};

const line = (level: DoctorLevel, check: string, text: string): DoctorLine => ({ level, check, text });

/** The database's own state: integrity, sizes and thread rows that do not match their messages. */
export function databaseSection(db: Database.Database): DoctorSection {
  const lines: DoctorLine[] = [];
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  try {
    const result = db.pragma("quick_check", { simple: true });
    lines.push(
      result === "ok"
        ? line("ok", "integrity", "The database passed its integrity check.")
        : line("fail", "integrity", "The database failed its integrity check. Restore a backup."),
    );
  } catch {
    lines.push(line("fail", "integrity", "The integrity check could not run."));
  }
  try {
    const messages = one("SELECT COUNT(*) AS n FROM messages");
    const threads = one("SELECT COUNT(*) AS n FROM threads");
    lines.push(line("ok", "rows", `${messages} messages in ${threads} conversations.`));
    const empty = one(
      "SELECT COUNT(*) AS n FROM threads t WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)",
    );
    const missing = one(
      "SELECT COUNT(*) AS n FROM (SELECT DISTINCT thread_id FROM messages) m WHERE NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = m.thread_id)",
    );
    lines.push(
      empty === 0 && missing === 0
        ? line("ok", "threads", "Every conversation matches its messages.")
        : line(
            "warn",
            "threads",
            `${empty} conversations have no messages and ${missing} are missing. Run doctor --repair-threads.`,
          ),
    );
    const pageSize = Number(db.pragma("page_size", { simple: true }));
    const pages = Number(db.pragma("page_count", { simple: true }));
    const free = Number(db.pragma("freelist_count", { simple: true }));
    const megabytes = (count: number) => ((count * pageSize) / (1024 * 1024)).toFixed(1);
    lines.push(line("ok", "size", `The database is ${megabytes(pages)} MB, ${megabytes(free)} MB of it free.`));
  } catch {
    lines.push(line("fail", "rows", "The database could not be read."));
  }
  return { accountId: null, title: "Database", lines };
}

/** One account's checks. Network checks run behind the account's queue, so they never race a sync round. */
export async function accountSection(
  deps: DoctorDeps,
  accountId: string,
  options: { repairThreads: boolean },
): Promise<DoctorSection | null> {
  const { store } = deps;
  const account = store.getAccount(accountId);
  if (account === null) return null;
  const lines: DoctorLine[] = [];

  let opens = false;
  if (deps.vault === null) {
    lines.push(line("fail", "credential", "The credential key is not set; saved passwords cannot be read."));
  } else {
    try {
      deps.vault.open(account.passwordSealed);
      opens = true;
      lines.push(line("ok", "credential", "The saved password can be read."));
    } catch {
      lines.push(line("fail", "credential", "The saved password cannot be read. Enter it again in Mail."));
    }
  }

  if (opens && deps.vault !== null) {
    const vault = deps.vault;
    const login = await deps
      .run(accountId, () => deps.gateway.test(imapConfigOf(account, vault)))
      .catch(() => null);
    if (login === null) lines.push(line("fail", "imap", "The mail server could not be reached."));
    else if (login.ok) lines.push(line("ok", "imap", "Sign-in to the mail server works."));
    else if (login.authFailed) lines.push(line("fail", "imap", "The mail server refused the sign-in. Update the app password."));
    else lines.push(line("fail", "imap", "The mail server could not be reached or refused the connection."));

    if (account.smtp === null) {
      lines.push(line("warn", "smtp", "No outgoing server is set: this account cannot send."));
    } else {
      const sent = await deps
        .run(accountId, async () => {
          const config = smtpConfigOf(account, { vault });
          try {
            await deps.transport.verify(config);
            return null;
          } catch (error) {
            return error instanceof SendError ? error.kind : "connect";
          } finally {
            config.password = "";
          }
        })
        .catch(() => "connect" as const);
      lines.push(
        sent === null
          ? line("ok", "smtp", "Sign-in to the outgoing server works.")
          : line("fail", "smtp", `The outgoing server check failed (${sent}).`),
      );
    }
  }

  const roles = new Set(store.listFolders(accountId).map((folder) => folder.specialUse));
  const wanted = ["inbox", "sent", "drafts", "trash", "junk", "archive"] as const;
  const absent = wanted.filter((role) => !roles.has(role));
  lines.push(
    absent.length === 0
      ? line("ok", "folders", "Inbox, Sent, Drafts, Trash, Spam and Archive folders are known.")
      : line(absent.includes("inbox") ? "fail" : "warn", "folders", `No folder is known for: ${absent.join(", ")}.`),
  );

  if (account.lastSyncAt === null) {
    lines.push(line("warn", "sync", "This account has not finished a sync yet."));
  } else {
    const minutes = Math.max(0, Math.round((deps.now().getTime() - Date.parse(account.lastSyncAt)) / 60_000));
    lines.push(line("ok", "sync", `Last full sync ${minutes} minutes ago.`));
  }
  for (const problem of parseSyncProblems(account.lastError)) {
    // `other` is text this version does not know: never printed as it came.
    lines.push(
      line("fail", "sync", problem.code === "other" ? "Sync reported a problem this version cannot name." : syncProblemText(problem)),
    );
  }

  const outbox = store.listOutbox(accountId);
  const count = (...states: string[]) => outbox.filter((row) => states.includes(row.state)).length;
  const stuck = count("failed", "unknown", "held");
  const waiting = count("waiting");
  lines.push(
    stuck === 0 && waiting === 0
      ? line("ok", "outbox", "Nothing is waiting in the Outbox.")
      : line(stuck > 0 ? "warn" : "ok", "outbox", `Outbox: ${waiting} waiting for the server, ${stuck} not sent.`),
  );

  if (options.repairThreads) {
    const threads = await deps.run(accountId, async () => store.repairThreads(accountId));
    lines.push(line("ok", "repair", `Rebuilt ${threads} conversations from their messages.`));
  }
  return { accountId, title: account.email, lines };
}

/** The worst level of a report, for the exit code and the one log line. */
export function worstLevel(sections: readonly DoctorSection[]): DoctorLevel {
  const levels = sections.flatMap((section) => section.lines.map((l) => l.level));
  return levels.includes("fail") ? "fail" : levels.includes("warn") ? "warn" : "ok";
}

export function doctorText(sections: readonly DoctorSection[]): string {
  return sections
    .map((section) =>
      [section.title, ...section.lines.map((l) => `  ${l.level.padEnd(4)} ${l.text}`)].join("\n"),
    )
    .join("\n\n");
}

export class BackupRefused extends Error {
  constructor(readonly reason: "not_absolute" | "no_directory" | "exists" | "failed") {
    super(reason);
    this.name = "BackupRefused";
  }
}

export const BACKUP_REFUSALS: Record<BackupRefused["reason"], string> = {
  not_absolute: "Give the backup file as a full path, for example /Users/me/mail-backup.db.",
  no_directory: "The folder for the backup file does not exist.",
  exists: "A file with that name already exists; Mail never overwrites a file.",
  failed: "The backup could not be written.",
};

/**
 * A consistent copy of the plugin's database at `file`, readable by the
 * owner only. Never writes over an existing file.
 */
export async function backupDatabase(
  db: Database.Database,
  file: string,
): Promise<{ bytes: number; messages: number }> {
  if (!isAbsolute(file) || file.includes("\0")) throw new BackupRefused("not_absolute");
  const folder = await stat(dirname(file)).catch(() => null);
  if (folder === null || !folder.isDirectory()) throw new BackupRefused("no_directory");
  if ((await stat(file).catch(() => null)) !== null) throw new BackupRefused("exists");
  try {
    await db.backup(file);
    await chmod(file, 0o600);
    const written = await stat(file);
    const messages = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
    return { bytes: written.size, messages };
  } catch {
    throw new BackupRefused("failed");
  }
}
