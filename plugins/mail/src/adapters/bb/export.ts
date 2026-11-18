// Export (slice 3o, #94): one folder of an account, read from the mail
// server through a read-only session (BODY.PEEK: nothing is marked read),
// written as one mbox file or as a new directory of .eml files. Never
// writes over anything that exists. The files are readable by the owner
// only. Runs in the owner's terminal; logs carry counts only.
import { chmod, mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { mboxEntry } from "../../core/mbox.ts";
import { ImapAuthError, type ImapGateway, type MailStore, type SecretVault } from "../../core/ports.ts";
import { RAW_MAX_BYTES } from "./downloads.ts";

export const EXPORT_MAX_DEFAULT = 2_000;
export const EXPORT_MAX_LIMIT = 50_000;

export type ExportFormat = "mbox" | "eml";

export type ExportReason =
  | "not_absolute"
  | "no_directory"
  | "exists"
  | "unknown_folder"
  | "needs_key"
  | "password"
  | "connection"
  | "failed";

export class ExportRefused extends Error {
  constructor(
    readonly reason: ExportReason,
    /** Messages written before the export stopped. */
    readonly written = 0,
  ) {
    super(reason);
    this.name = "ExportRefused";
  }
}

export const EXPORT_REFUSALS: Record<ExportReason, string> = {
  not_absolute: "Give the export as a full path, for example /Users/me/inbox.mbox.",
  no_directory: "The folder for the export does not exist.",
  exists: "Something with that name already exists; Mail never overwrites a file.",
  unknown_folder: "This account has no such folder. Give the folder's full name as Mail's sidebar shows it, for example INBOX.",
  needs_key: "Set the credential key in the plugin settings first.",
  password: "This account needs its password re-entered.",
  connection: "The mail server could not be read; what was written so far is kept.",
  failed: "The export could not be written.",
};

export type ExportDeps = {
  store: MailStore;
  gateway: ImapGateway;
  /** Null while the credential key is not set. */
  vault: SecretVault | null;
  now: () => Date;
};

export type ExportInput = {
  accountId: string;
  folder: string;
  /** The mbox file, or for `eml` the directory, to create. */
  file: string;
  format: ExportFormat;
  /** Only messages the server dates on or after this day. */
  since: Date | null;
  /** At most this many, the newest. */
  max: number;
};

export type ExportResult = {
  /** Messages written. */
  messages: number;
  /** Messages the server could not give (gone meanwhile, or over the size cap). */
  skipped: number;
  /** Messages of the folder (within `since`) left out by `max`. */
  left: number;
  bytes: number;
};

/**
 * Writes the folder's messages, oldest first. A refusal before anything is
 * written leaves nothing behind; a failure midway keeps what was written and
 * says how many messages that is.
 */
export async function exportFolder(deps: ExportDeps, input: ExportInput): Promise<ExportResult> {
  const { store } = deps;
  const account = store.getAccount(input.accountId);
  if (account === null) throw new ExportRefused("unknown_folder");
  if (!store.listFolders(account.id).some((folder) => folder.path === input.folder && folder.selectable)) {
    throw new ExportRefused("unknown_folder");
  }
  if (deps.vault === null) throw new ExportRefused("needs_key");
  if (account.authFailed) throw new ExportRefused("password");
  if (!isAbsolute(input.file) || input.file.includes("\0")) throw new ExportRefused("not_absolute");
  const parent = await stat(dirname(input.file)).catch(() => null);
  if (parent === null || !parent.isDirectory()) throw new ExportRefused("no_directory");
  if ((await stat(input.file).catch(() => null)) !== null) throw new ExportRefused("exists");

  let session: Awaited<ReturnType<ImapGateway["openFolder"]>>;
  let uids: number[];
  try {
    const config = { host: account.host, port: account.port, user: account.username, password: deps.vault.open(account.passwordSealed) };
    session = await deps.gateway.openFolder(config, input.folder, { readOnly: true });
  } catch (error) {
    throw new ExportRefused(error instanceof ImapAuthError ? "password" : "connection");
  }
  let messages = 0;
  let skipped = 0;
  let bytes = 0;
  let left = 0;
  try {
    try {
      const all = (input.since === null ? await session.uidsAfter(0) : await session.searchSince(input.since)).sort((a, b) => a - b);
      left = Math.max(0, all.length - input.max);
      uids = all.slice(left);
    } catch {
      throw new ExportRefused("connection");
    }
    // "wx": fails when the name was taken since the check above.
    const out = input.format === "mbox" ? await open(input.file, "wx", 0o600).catch(() => null) : null;
    if (input.format === "mbox" && out === null) throw new ExportRefused("failed");
    if (input.format === "eml") {
      try {
        await mkdir(input.file, { mode: 0o700 });
      } catch {
        throw new ExportRefused("failed");
      }
    }
    try {
      for (const uid of uids) {
        let raw: Uint8Array;
        try {
          raw = await session.fetchRaw(uid, RAW_MAX_BYTES);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === "NotFound" || code === "TooLarge") {
            skipped += 1;
            continue;
          }
          throw new ExportRefused("connection", messages);
        }
        try {
          if (out !== null) {
            const entry = mboxEntry(raw, deps.now());
            await out.write(entry);
            bytes += entry.length;
          } else {
            const name = join(input.file, `${String(uid).padStart(8, "0")}.eml`);
            await writeFile(name, raw, { flag: "wx", mode: 0o600 });
            bytes += raw.length;
          }
        } catch {
          throw new ExportRefused("failed", messages);
        }
        messages += 1;
      }
    } finally {
      await out?.close().catch(() => {});
      if (out !== null) await chmod(input.file, 0o600).catch(() => {});
    }
  } finally {
    await session.close().catch(() => {});
  }
  return { messages, skipped, left, bytes };
}
