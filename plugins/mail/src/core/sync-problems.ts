// What is wrong with an account's sync, as codes (slice 3j). The store keeps
// one English line per account (`lastError`), made of fixed sentences that
// `sync.ts` and the sync service write; this module reads that line back
// into codes, so the page can show it in its own language and tell a lost
// network (quiet) from a problem the owner has to fix (a banner). Text it
// does not know stays as it is, under the code `other`.

export type SyncProblemCode =
  | "auth_failed"
  | "credential_unreadable"
  | "network"
  | "server_busy"
  | "tls"
  | "server"
  | "folder_gone_moves_dropped"
  | "renumbered_moves_dropped"
  | "flags_not_saved"
  | "moves_returned"
  | "other";

export type SyncProblem = {
  code: SyncProblemCode;
  /** The folder the problem is about, as the server names it; data, never markup. */
  folder: string | null;
  /** Messages or moves affected, when the sentence gives a number. */
  count: number | null;
  /** The error code inside "Sync failed (…)", or the unknown sentence for `other`. */
  detail: string | null;
};

/** Socket and DNS failures: the server was never reached. */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ETIMEOUT",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ESOCKET",
  "ECONNECTION",
  "NoConnection",
  "ConnectionClosed",
  "Timeout",
  "SocketTimeout",
  "ConnectTimeout",
  "GreetingTimeout",
]);

/** The server answered and asked to come back later. */
const BUSY_CODES = new Set(["UNAVAILABLE", "INUSE", "LIMIT", "SERVERBUG", "ALERT", "LoginThrottled", "Throttled"]);

const TLS_CODE = /TLS|SSL|CERT|ALTNAME|HANDSHAKE/i;

export const DECRYPT_ERROR_TEXT = "Cannot decrypt credential — re-enter the password";

/** How long a sentence the parser will look at; `lastError` is short, mail data is not in it. */
const SENTENCE_MAX = 600;
const PROBLEMS_MAX = 20;

function failureCode(detail: string | null): SyncProblemCode {
  if (detail === null) return "server";
  if (NETWORK_CODES.has(detail)) return "network";
  if (BUSY_CODES.has(detail)) return "server_busy";
  if (TLS_CODE.test(detail)) return "tls";
  return "server";
}

function problem(code: SyncProblemCode, patch: Partial<SyncProblem> = {}): SyncProblem {
  return { code, folder: null, count: null, detail: null, ...patch };
}

/** One sentence of `lastError` as a problem. */
function parseSentence(sentence: string): SyncProblem {
  if (sentence === "Authentication failed") return problem("auth_failed");
  if (sentence === DECRYPT_ERROR_TEXT) return problem("credential_unreadable");
  if (sentence === "Sync failed") return problem("server");

  let match = /^Sync failed \(([A-Za-z0-9_.-]{1,64})\)$/.exec(sentence);
  if (match) return problem(failureCode(match[1]!), { detail: match[1]! });

  match = /^Could not move (\d{1,9}) message\(s\); they were returned to (.+)$/s.exec(sentence);
  if (match) return problem("moves_returned", { count: Number(match[1]), folder: match[2]! });

  match = /^(.+) no longer exists; (\d{1,9}) queued move\(s\) were dropped$/s.exec(sentence);
  if (match) return problem("folder_gone_moves_dropped", { folder: match[1]!, count: Number(match[2]) });

  match = /^(.+) was renumbered by the server; (\d{1,9}) queued move\(s\) were dropped$/s.exec(sentence);
  if (match) return problem("renumbered_moves_dropped", { folder: match[1]!, count: Number(match[2]) });

  // "<folder>: <what>" — the last ": " splits, so a folder name with a colon stays whole.
  const at = sentence.lastIndexOf(": ");
  if (at > 0) {
    const folder = sentence.slice(0, at);
    const what = sentence.slice(at + 2);
    if (what === "could not update flags on the server") return problem("flags_not_saved", { folder });
    if (what === "Authentication failed") return problem("auth_failed", { folder });
    if (what === "Sync failed") return problem("server", { folder });
    const code = /^Sync failed \(([A-Za-z0-9_.-]{1,64})\)$/.exec(what);
    if (code) return problem(failureCode(code[1]!), { folder, detail: code[1]! });
  }
  return problem("other", { detail: sentence });
}

/** The account's `lastError` as problems, in the order they were written; at most 20. */
export function parseSyncProblems(lastError: string | null): SyncProblem[] {
  if (lastError === null || lastError === "") return [];
  return sentencesOf(lastError)
    .slice(0, PROBLEMS_MAX)
    .map((sentence) => parseSentence(sentence.slice(0, SENTENCE_MAX)));
}

/** A first half that goes with the next part: three of sync's sentences hold a "; " themselves. */
const FIRST_HALF = /^Could not move \d{1,9} message\(s\)$| no longer exists$| was renumbered by the server$/;
const SECOND_HALF = /^they were returned to |^\d{1,9} queued move\(s\) were dropped$/;

/** `lastError` cut into its sentences. Linear: one pass over the parts. */
function sentencesOf(lastError: string): string[] {
  const parts = lastError.split("; ", PROBLEMS_MAX * 2 + 1);
  const sentences: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (next !== undefined && FIRST_HALF.test(part.slice(-80)) && SECOND_HALF.test(next.slice(0, 80))) {
      sentences.push(`${part}; ${next}`);
      i++;
    } else {
      sentences.push(part);
    }
  }
  return sentences;
}

/** How long a lost network stays a quiet "Offline" before it becomes a banner. */
export const OFFLINE_QUIET_MS = 30 * 60_000;

/**
 * True when the account's only trouble is the network (or a busy server)
 * and its last good sync is recent: nothing for the owner to fix yet.
 */
export function isQuietlyOffline(
  account: { lastError: string | null; lastSyncAt: string | null; authFailed: boolean },
  nowMs: number,
): boolean {
  if (account.authFailed || account.lastSyncAt === null) return false;
  const problems = parseSyncProblems(account.lastError);
  if (problems.length === 0) return false;
  if (!problems.every((p) => p.code === "network" || p.code === "server_busy")) return false;
  const synced = Date.parse(account.lastSyncAt);
  return Number.isFinite(synced) && nowMs - synced < OFFLINE_QUIET_MS;
}

/** The problem in English, as one sentence for the banner and the status panel. */
export function syncProblemText(p: SyncProblem): string {
  const where = p.folder !== null ? `${p.folder}: ` : "";
  const code = p.detail !== null ? ` (${p.detail})` : "";
  switch (p.code) {
    case "auth_failed":
      return `${where}The server refused the sign-in. Update the app password.`;
    case "credential_unreadable":
      return "The saved password cannot be read. Enter it again.";
    case "network":
      return `${where}The mail server could not be reached${code}.`;
    case "server_busy":
      return `${where}The mail server is busy and asked to try later${code}.`;
    case "tls":
      return `${where}The secure connection to the mail server failed${code}.`;
    case "server":
      return `${where}Sync failed${code}.`;
    case "folder_gone_moves_dropped":
      return `${p.folder} no longer exists on the server; ${p.count} queued moves were dropped.`;
    case "renumbered_moves_dropped":
      return `${p.folder} was renumbered by the server; ${p.count} queued moves were dropped.`;
    case "flags_not_saved":
      return `${where}Read and flag changes could not be saved on the server.`;
    case "moves_returned":
      return `${p.count} messages could not be moved; they are back in ${p.folder}.`;
    case "other":
      return p.detail ?? "Sync failed.";
  }
}
