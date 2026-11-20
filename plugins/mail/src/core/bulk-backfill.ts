// Bulk marks for mail synced before the mark existed (messages.bulk NULL).
// Sync never refetches those rows, so this asks the server for only the four
// header fields the classifier reads (BODY.PEEK[HEADER.FIELDS (...)], by UID,
// on a read-only session: never \Seen, no body) and judges them with the same
// classifyBulk sync uses, against the stored sender.
//
// A round takes at most `budget` rows of one account, newest uid first per
// folder, in `batchSize` fetches. A folder is skipped while the server's
// UIDVALIDITY differs from the stored one (the uids would name other mail),
// and the store writes a mark only where it is still NULL and the stored
// UIDVALIDITY still matches, so a value sync set is never overwritten. A uid
// the server does not answer for stays NULL; `cursors` (kept by the caller
// for the life of the process) moves below it, so it is not asked again
// until a restart. Never throws; returns counts only, never mail text.
//
// Slice 3g: the same fetch also keeps the List-Id where it is unknown
// (messages.list_id NULL, '' when absent), so list binding rules and rule
// matches apply to mail synced before 3g; rows needing only the List-Id are
// fetched too, within the same budget and UIDVALIDITY rule.
import { classifyBulk } from "./contacts.ts";
import { normalizeListId } from "./dev-notify.ts";
import { headerLines, headerValue } from "./headers.ts";
import type { BulkHeaders, Folder } from "./model.ts";
import { ImapAuthError, type FolderSession, type ImapGateway, type MailStore, type SecretVault } from "./ports.ts";
import { UNSUBSCRIBE_HEADER_FIELDS, unsubscribeInfoOf } from "./unsubscribe.ts";

/** The header fields the classifier reads, as asked from the server. */
export const LIST_HEADER_FIELDS = ["List-Id", "List-Unsubscribe", "Precedence", "Auto-Submitted"] as const;

/** Rows one account backfills per round. */
export const BACKFILL_BUDGET = 500;
/** Uids per header fetch. */
export const BACKFILL_BATCH = 100;

/** Per account and folder (cursorKey): the uid the next round starts below, for one UIDVALIDITY. */
export type BackfillCursors = Map<string, { uidValidity: number; belowUid: number }>;

export interface BackfillDeps {
  store: MailStore;
  gateway: ImapGateway;
  vault: SecretVault;
}

export interface BackfillOptions {
  cursors: BackfillCursors;
  budget?: number;
  batchSize?: number;
  signal?: AbortSignal;
}

export type BackfillOutcome = {
  /** Rows whose mark (or unsubscribe info) was filled. */
  marked: number;
  /** Rows asked for that the server did not return (they stay NULL). */
  unanswered: number;
  /** Folders whose headers were fetched. */
  folders: number;
  /** Folders left alone because their UIDVALIDITY changed. */
  skipped: number;
  /** Folders (or the account) that failed; a rejected login ends the round. */
  failed: number;
};

/** The bulk headers of a fetched HEADER.FIELDS block: unfolded, first value of each, null when absent. */
export function bulkHeadersOf(block: Uint8Array): BulkHeaders {
  return {
    listId: headerValue(block, "List-Id"),
    listUnsubscribe: headerValue(block, "List-Unsubscribe"),
    precedence: headerValue(block, "Precedence"),
    autoSubmitted: headerValue(block, "Auto-Submitted"),
  };
}

export function cursorKey(accountId: string, folder: string): string {
  return `${accountId}\u0000${folder}`;
}

export async function backfillBulk(
  deps: BackfillDeps,
  accountId: string,
  options: BackfillOptions,
): Promise<BackfillOutcome> {
  return backfillPass(deps, accountId, options, BACKFILL_BUDGET, {
    folders: () => true,
    cursorKey,
    unknown: (path, below, limit) => {
      // Rows missing the mark, the List-Id or both, newest uid first; `fromAddress` null: the mark is known.
      const rows = new Map<number, { uid: number; fromAddress: string | null }>();
      for (const row of deps.store.listUnknown(accountId, path, below, limit)) rows.set(row.uid, { uid: row.uid, fromAddress: null });
      for (const row of deps.store.bulkUnknown(accountId, path, below, limit)) rows.set(row.uid, row);
      return [...rows.values()].sort((a, b) => b.uid - a.uid).slice(0, limit);
    },
    fetch: (session, uids) => session.fetchListHeaders(uids),
    fill: (path, uidValidity, found) => {
      const listIds = (rows: typeof found) =>
        rows.map(({ row, block }) => ({ uid: row.uid, listId: normalizeListId(bulkHeadersOf(block).listId) ?? "" }));
      const marks = found.flatMap(({ row, block }) =>
        row.fromAddress === null ? [] : [{ uid: row.uid, bulk: classifyBulk(bulkHeadersOf(block), row.fromAddress) }],
      );
      const marked = deps.store.fillBulk(accountId, path, uidValidity, marks);
      deps.store.fillListIds(accountId, path, uidValidity, listIds(found.filter(({ row }) => row.fromAddress !== null)));
      // A row that needed only its List-Id counts once, when it was filled.
      return marked + deps.store.fillListIds(accountId, path, uidValidity, listIds(found.filter(({ row }) => row.fromAddress === null)));
    },
  });
}

/** Rows one account's unsubscribe backfill takes per round (spec "Mail synced before element 8"). */
export const UNSUBSCRIBE_BACKFILL_BUDGET = 200;

/** The cursor key of the unsubscribe pass: its own, beside the bulk pass's. */
export function unsubscribeCursorKey(accountId: string, folder: string): string {
  return `${accountId}\u0000${folder}\u0000unsubscribe`;
}

/**
 * The second pass (slice 3e): unsubscribe info for Inbox-role bulk rows
 * synced before it existed (`unsubscribe_json` NULL), from the header fields
 * unsubscribeInfoOf reads (UNSUBSCRIBE_HEADER_FIELDS), with the same
 * UIDVALIDITY guard and fill-where-NULL rule as the bulk pass. A message
 * without List-Unsubscribe stays NULL; the cursor moves below it.
 */
export async function backfillUnsubscribe(
  deps: BackfillDeps,
  accountId: string,
  options: BackfillOptions,
): Promise<BackfillOutcome> {
  const preset = deps.store.getAccount(accountId)?.preset ?? "other";
  return backfillPass(deps, accountId, options, UNSUBSCRIBE_BACKFILL_BUDGET, {
    folders: (folder) => folder.specialUse === "inbox",
    cursorKey: unsubscribeCursorKey,
    unknown: (path, below, limit) => deps.store.unsubscribeUnknown(accountId, path, below, limit),
    fetch: (session, uids) => session.fetchHeaderFields(uids, UNSUBSCRIBE_HEADER_FIELDS),
    fill: (path, uidValidity, found) =>
      deps.store.fillUnsubscribe(
        accountId,
        path,
        uidValidity,
        found.map(({ row, block }) => ({ uid: row.uid, info: unsubscribeInfoOf(headerLines(block), preset, row.from) })),
      ),
  });
}

type PassRow = { uid: number };

/** What one backfill pass reads and writes; the loop, guards and cursors are shared. */
type Pass<R extends PassRow> = {
  folders: (folder: Folder) => boolean;
  cursorKey: (accountId: string, folder: string) => string;
  unknown: (path: string, belowUid: number | null, limit: number) => R[];
  fetch: (session: FolderSession, uids: number[]) => Promise<{ uid: number; block: Uint8Array }[]>;
  /** Writes what the found blocks say; returns how many rows changed. */
  fill: (path: string, uidValidity: number, found: { row: R; block: Uint8Array }[]) => number;
};

async function backfillPass<R extends PassRow>(
  deps: BackfillDeps,
  accountId: string,
  options: BackfillOptions,
  defaultBudget: number,
  pass: Pass<R>,
): Promise<BackfillOutcome> {
  const { store, gateway, vault } = deps;
  const batchSize = Math.max(1, options.batchSize ?? BACKFILL_BATCH);
  const aborted = () => options.signal?.aborted === true;
  const outcome: BackfillOutcome = { marked: 0, unanswered: 0, folders: 0, skipped: 0, failed: 0 };
  let left = options.budget ?? defaultBudget;

  try {
    if (aborted()) return outcome;
    const account = store.getAccount(accountId);
    if (account === null || account.authFailed) return outcome;
    let password: string;
    try {
      password = vault.open(account.passwordSealed);
    } catch {
      return outcome;
    }
    const config = { host: account.host, port: account.port, user: account.username, password, authKind: account.authKind };

    for (const folder of store.listFolders(accountId)) {
      if (aborted() || left <= 0) break;
      if (!folder.selectable || !pass.folders(folder)) continue;
      const path = folder.path;
      const state = store.getSyncState(accountId, path);
      if (state === null) continue;
      const key = pass.cursorKey(accountId, path);
      const cursor = options.cursors.get(key);
      const below = cursor !== undefined && cursor.uidValidity === state.uidValidity ? cursor.belowUid : null;
      const rows = pass.unknown(path, below, left);
      if (rows.length === 0) continue;

      let session;
      try {
        session = await gateway.openFolder(config, path, { readOnly: true });
      } catch (error) {
        outcome.failed++;
        if (error instanceof ImapAuthError) break;
        continue;
      }
      try {
        const status = await session.status();
        if (status.uidValidity !== state.uidValidity) {
          outcome.skipped++;
          continue;
        }
        outcome.folders++;
        for (let i = 0; i < rows.length && !aborted(); i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const blocks = new Map(
            (await pass.fetch(session, batch.map((row) => row.uid))).map((found) => [found.uid, found.block]),
          );
          const found = batch.flatMap((row) => {
            const block = blocks.get(row.uid);
            return block === undefined ? [] : [{ row, block }];
          });
          outcome.marked += pass.fill(path, state.uidValidity, found);
          outcome.unanswered += batch.length - found.length;
          left -= batch.length;
          options.cursors.set(key, {
            uidValidity: state.uidValidity,
            belowUid: Math.min(...batch.map((row) => row.uid)),
          });
        }
      } catch (error) {
        outcome.failed++;
        if (error instanceof ImapAuthError) break;
      } finally {
        try {
          await session.close();
        } catch {
          // The marks already written stay; a failed logout changes nothing.
        }
      }
    }
  } catch {
    // A store failure (or the host closing it on abort) ends the round quietly.
    outcome.failed++;
  }
  return outcome;
}
