// The server search strip (slice 3h, #35): one line per account while Mail
// searches the owner's own mail servers, with Cancel, and what came of it:
// how much was searched, a partial stop, a refused search, and More from the
// server. Hits arrive in the result list itself, marked "from the server".
import type { RpcOut } from "../core/contract.ts";
import type { SearchField } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { tx } from "./i18n/index.ts";

export type ServerJobView = RpcOut<"server_job_poll">;
export type ServerAccountView = ServerJobView["accounts"][number];

/** The server could not take the query's text: non-ASCII words read differently (spec resolution 20). */
function nonAscii(query: string): boolean {
  return /[^\x00-\x7f]/.test(query);
}

/** One account's line. */
export function accountLine(
  row: ServerAccountView,
  state: ServerJobView["state"],
  query: string,
  shown: number,
): string {
  switch (row.reason) {
    case "search_failed":
      return nonAscii(query) ? "This server could not search for this text" : "The server refused the search";
    case "connection_failed":
      return "Could not connect to the server";
    case "password_needed":
      return "The account needs its password again";
    case "not_synced":
      return "Not synced yet; nothing searched";
    case "nothing_to_search":
      return "Nothing to search on this server";
    case "time_budget":
      return `Stopped after ${row.searched} ${row.searched === 1 ? "folder" : "folders"} \u2014 narrow with in:`;
    case "changed":
      return "The server's folders changed; search again";
    case "cancelled":
      return "Stopped";
    case null:
      break;
  }
  if (state === "running") {
    return row.total > 0 ? `${row.searched} of ${row.total} folders\u2026` : "Searching\u2026";
  }
  if (state === "cancelled") return "Stopped";
  const found = `${row.found} found`;
  return row.partial ? `${found} \u00b7 stopped early \u2014 narrow with in:` : shown > 0 && shown < row.found ? `${shown} shown \u00b7 ${found}` : found;
}

const FIELD_TEXT: Partial<Record<SearchField, string>> = {
  has: "has:",
  filename: "filename:",
  is: "is:",
  list: "list:",
  category: "category:",
  label: "label:",
  account: "account:",
  in: "in:",
  larger: "larger:",
  smaller: "smaller:",
};

export function ServerSearchStrip({
  job,
  query,
  localOnly,
  accountName,
  shownFromServer,
  onCancel,
  onMore,
}: {
  job: ServerJobView;
  query: string;
  /** Operators the server did not use (they still narrow the hits here). */
  localOnly: readonly SearchField[];
  accountName: (accountId: string) => string;
  /** Hits from the server now in the list. */
  shownFromServer: number;
  onCancel: () => void;
  onMore: () => void;
}) {
  const running = job.state === "running";
  const narrowed = [...new Set(localOnly.map((field) => FIELD_TEXT[field] ?? `${field}:`))];
  return (
    <div role="status" aria-label={tx("Server search")} className="flex flex-col gap-1 border-b border-border bg-card px-3 py-2 text-xs text-muted-foreground">
      <ul className="flex flex-col gap-0.5">
        {job.accounts.map((row) => (
          <li key={row.accountId} className="flex min-w-0 items-center gap-1">
            <Icon name="Server" fallback="Mail" className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              <span className="text-foreground">{accountName(row.accountId)}</span>
              {`: ${accountLine(row, job.state, query, shownFromServer)}`}
            </span>
          </li>
        ))}
      </ul>
      {job.state === "failed" ? <p role="alert" className="text-destructive">{tx("The server search failed")}</p> : null}
      {narrowed.length > 0 ? <p>{`Checked in Mail only: ${narrowed.join(", ")}`}</p> : null}
      <div className="flex flex-wrap items-center gap-1">
        {running ? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>
            {tx("Cancel")}
          </Button>
        ) : null}
        {!running && job.moreAvailable ? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onMore}>
            {tx("More from the server")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
