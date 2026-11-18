// Slice 3i server side of the sender check (part A resolutions 5, 7, 16, 18):
// the known-domain cache of the lookalike and Reply-To checks, the header
// view fields thread_get adds, the old-row refresh (one read-only PEEK
// session per folder through the account queue) and Details' authenticity
// lines from a raw message. No content reaches the log: only
// `sender_check <id>: fetch failed (<kind>)`.
import {
  authenticityLines,
  capHeaderLines,
  cryptoKindOf,
  imapConfigOf,
  knownDomainsOf,
  PROVIDER_TRACE_HEADERS,
  readStoredCheck,
  receiptRequested,
  SECURITY_HEADER_FIELDS,
  securityViews,
  senderCheckOf,
  UNSUBSCRIBE_HEADER_FIELDS,
  type AccountPreset,
  type Clock,
  type HeaderLine,
  type ImapGateway,
  type KnownDomains,
  type MailStore,
  type MessageHeader,
  type SecretVault,
  type SecurityView,
  type SenderCheckRow,
} from "../../core/index.ts";
import { headerLines } from "../../core/headers.ts";
import { ownAddresses } from "../../core/compose.ts";

/** The known set is rebuilt at most this often after it went stale. */
export const KNOWN_REBUILD_MS = 60_000;
/** Most ids one sender_check_refresh call takes (the contract says the same). */
export const SENDER_CHECK_REFRESH_MAX = 50;

export type SenderChecksDeps = {
  store: MailStore;
  clock: Clock;
  gateway: ImapGateway;
  vault: SecretVault;
  queue: { run<T>(accountId: string, task: () => Promise<T>): Promise<T> };
  vaultReady: () => boolean;
  log: (line: string) => void;
  publishChanged: (accountId: string | null) => void;
};

export type SenderChecks = {
  /** The cached known set: built on first use, rebuilt when stale and a minute old. */
  known(): KnownDomains;
  /** A send finished or a round inserted Sent rows: the next read may rebuild the set. */
  markStale(): void;
  /** The 3i views of these stored messages. */
  views(ids: readonly string[]): Map<string, SecurityView>;
  /** Headers with senderCheck, warnings, receiptRequested and crypto filled from the store. */
  secure<H extends MessageHeader>(headers: H[]): H[];
  /** sender_check_refresh: fetches and stores the check of `unknown` rows (every row with `force`). */
  refresh(input: { messageIds: string[]; force?: boolean | undefined }): Promise<{ refreshed: number; failed: number }>;
  /**
   * Details' authenticity from a raw message's full header block, storing
   * the check where the stored one reads `unknown`.
   */
  fromRaw(messageId: string, raw: Uint8Array): { authserv: string | null; lines: string[] };
};

const UNSUBSCRIBE_NAMES = new Set(UNSUBSCRIBE_HEADER_FIELDS.map((name) => name.toLowerCase()));
const TRACE_PREFIXES = [
  ...new Set(
    Object.values(PROVIDER_TRACE_HEADERS)
      .flat()
      .filter((name) => name.endsWith("*"))
      .map((name) => name.slice(0, -1).toLowerCase()),
  ),
];

const isKept = (key: string) => UNSUBSCRIBE_NAMES.has(key) || TRACE_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * The lines the sync-time check reads (as the gateway keeps them), so
 * open-time verdicts agree (resolution 16). With the `whole` header block
 * (Details' raw message), the first line of any other name stays as an empty
 * marker, so the provider's top block ends where it really does: a
 * trusted-id header the sender wrote under its own Subject is never counted
 * (slice 3i review, finding 12). A partial fetch (the refresh) cannot know.
 */
function judgedLines(lines: readonly HeaderLine[], whole: boolean): HeaderLine[] {
  const out: HeaderLine[] = [];
  let marked = !whole;
  for (const line of lines) {
    const key = line.key.toLowerCase();
    if (isKept(key)) out.push(line);
    else if (!marked) {
      out.push({ key, value: "" });
      marked = true;
    }
  }
  return out;
}

/** What one fetched header block says, judged as sync would for this stored row; `whole` for Details' raw message. */
function judge(row: SenderCheckRow, lines: readonly HeaderLine[], preset: AccountPreset, whole: boolean) {
  const cap = !whole;
  const kept = judgedLines(lines, whole);
  const check = senderCheckOf(cap ? capHeaderLines(kept) : kept, preset, row.from, { folderRole: row.folderRole });
  const contentType = lines.find((line) => line.key.toLowerCase() === "content-type")?.value ?? null;
  return { check, receipt: receiptRequested(lines), crypto: cryptoKindOf(contentType, row.firstLine) };
}

/** Name and code of a failure, never its message. */
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? `${error.name} ${code}` : error.name;
}

export function createSenderChecks(deps: SenderChecksDeps): SenderChecks {
  const { store } = deps;
  let cache: { set: KnownDomains; builtAt: number } | null = null;
  let stale = false;
  /** Message ids with a refresh in flight: a second request for one is dropped (part B I3). */
  const inFlight = new Set<string>();

  const presetOf = (accountId: string): AccountPreset => store.getAccount(accountId)?.preset ?? "other";
  const own = () => new Set(ownAddresses(store));

  function known(): KnownDomains {
    const now = deps.clock.now().getTime();
    if (cache === null || (stale && now - cache.builtAt >= KNOWN_REBUILD_MS)) {
      cache = { set: knownDomainsOf(store), builtAt: now };
      stale = false;
    }
    return cache.set;
  }

  function views(ids: readonly string[]): Map<string, SecurityView> {
    if (ids.length === 0) return new Map();
    return securityViews(store, ids, { known: known(), own: own() });
  }

  function secure<H extends MessageHeader>(headers: H[]): H[] {
    const found = views(headers.map((header) => header.id));
    return headers.map((header) => {
      const view = found.get(header.id);
      if (view === undefined) return header;
      return { ...header, senderCheck: view.senderCheck, warnings: view.warnings, receiptRequested: view.receiptRequested, crypto: view.crypto };
    });
  }

  /** Whether the stored check is read as `unknown` although a value is stored (the re-pinned case). */
  const repinned = (row: SenderCheckRow) =>
    row.senderCheckJson !== null && readStoredCheck(row.senderCheckJson, presetOf(row.accountId)).state === "unknown";

  async function refreshFolder(
    accountId: string,
    folder: string,
    rows: SenderCheckRow[],
    force: boolean,
  ): Promise<{ refreshed: number; failed: number }> {
    const account = store.getAccount(accountId);
    if (account === null || account.authFailed || !deps.vaultReady()) return { refreshed: 0, failed: rows.length };
    try {
      return await deps.queue.run(accountId, async () => {
        // Read again inside the queue: a move or a reset may have run first.
        const current = store.senderCheckRows(rows.map((row) => row.id)).filter((row) => row.folder === folder && row.uid !== null);
        if (current.length === 0) return { refreshed: 0, failed: rows.length };
        const session = await deps.gateway.openFolder(imapConfigOf(account, deps.vault), folder, { readOnly: true });
        try {
          const { uidValidity } = await session.status();
          const blocks = await session.fetchHeaderFields(
            current.map((row) => row.uid!),
            SECURITY_HEADER_FIELDS,
          );
          const byUid = new Map(blocks.map((found) => [found.uid, found.block] as const));
          let refreshed = 0;
          for (const row of current) {
            const block = byUid.get(row.uid!);
            if (block === undefined) continue;
            const judged = judge(row, headerLines(block), account.preset, false);
            const wrote = store.writeSenderCheck(row.id, {
              ...judged,
              force: force || repinned(row),
              guard: { uidValidity },
            });
            if (wrote) refreshed++;
          }
          return { refreshed, failed: rows.length - refreshed };
        } finally {
          await session.close().catch(() => undefined);
        }
      });
    } catch (error) {
      deps.log(`sender_check ${rows[0]!.id}: fetch failed (${errorKind(error)})`);
      return { refreshed: 0, failed: rows.length };
    }
  }

  async function refresh(input: { messageIds: string[]; force?: boolean | undefined }): Promise<{ refreshed: number; failed: number }> {
    const force = input.force === true;
    const ids = [...new Set(input.messageIds)].slice(0, SENDER_CHECK_REFRESH_MAX).filter((id) => !inFlight.has(id));
    const rows = store
      .senderCheckRows(ids)
      .filter((row) => row.uid !== null && (force || row.senderCheckJson === null || repinned(row)));
    if (rows.length === 0) return { refreshed: 0, failed: 0 };
    const groups = new Map<string, SenderCheckRow[]>();
    for (const row of rows) {
      const key = `${row.accountId}\u0000${row.folder}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [row]);
      else group.push(row);
    }
    for (const row of rows) inFlight.add(row.id);
    try {
      const results = await Promise.all(
        [...groups.values()].map((group) => refreshFolder(group[0]!.accountId, group[0]!.folder, group, force)),
      );
      const total = results.reduce((sum, result) => ({ refreshed: sum.refreshed + result.refreshed, failed: sum.failed + result.failed }), {
        refreshed: 0,
        failed: 0,
      });
      if (total.refreshed > 0) {
        for (const accountId of new Set(rows.map((row) => row.accountId))) deps.publishChanged(accountId);
      }
      return total;
    } finally {
      for (const row of rows) inFlight.delete(row.id);
    }
  }

  function fromRaw(messageId: string, raw: Uint8Array): { authserv: string | null; lines: string[] } {
    const [row] = store.senderCheckRows([messageId]);
    if (row === undefined) return { authserv: null, lines: [] };
    // The full header block, without the 64-line cap (resolution 7).
    const judged = judge(row, headerLines(raw), presetOf(row.accountId), true);
    if (row.senderCheckJson === null || repinned(row)) {
      try {
        store.writeSenderCheck(row.id, { ...judged, force: repinned(row) });
      } catch {
        // Details still shows what the raw message says; the next open tries again.
      }
    }
    return { authserv: judged.check.authserv, lines: authenticityLines(judged.check) };
  }

  return { known, markStale: () => void (stale = true), views, secure, refresh, fromRaw };
}
