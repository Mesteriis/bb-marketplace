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
import { classifyBulk } from "./contacts.ts";
import { headerValue } from "./headers.ts";
import type { BulkHeaders } from "./model.ts";
import { ImapAuthError, type ImapGateway, type MailStore, type SecretVault } from "./ports.ts";

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
  /** Rows whose mark was filled. */
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
  const { store, gateway, vault } = deps;
  const batchSize = Math.max(1, options.batchSize ?? BACKFILL_BATCH);
  const aborted = () => options.signal?.aborted === true;
  const outcome: BackfillOutcome = { marked: 0, unanswered: 0, folders: 0, skipped: 0, failed: 0 };
  let left = options.budget ?? BACKFILL_BUDGET;

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
    const config = { host: account.host, port: account.port, user: account.username, password };

    for (const folder of store.listFolders(accountId)) {
      if (aborted() || left <= 0) break;
      if (!folder.selectable) continue;
      const path = folder.path;
      const state = store.getSyncState(accountId, path);
      if (state === null) continue;
      const key = cursorKey(accountId, path);
      const cursor = options.cursors.get(key);
      const below = cursor !== undefined && cursor.uidValidity === state.uidValidity ? cursor.belowUid : null;
      const rows = store.bulkUnknown(accountId, path, below, left);
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
            (await session.fetchListHeaders(batch.map((row) => row.uid))).map((found) => [found.uid, found.block]),
          );
          const marks = batch.flatMap((row) => {
            const block = blocks.get(row.uid);
            return block === undefined ? [] : [{ uid: row.uid, bulk: classifyBulk(bulkHeadersOf(block), row.fromAddress) }];
          });
          outcome.marked += store.fillBulk(accountId, path, state.uidValidity, marks);
          outcome.unanswered += batch.length - marks.length;
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
