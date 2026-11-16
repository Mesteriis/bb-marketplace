// Saved searches (slice 3h, #63): the rail's Saved section with unread
// counts, and the dialog that saves, renames or edits one. Opening a saved
// search runs it as the page's search; its menu holds Rename, Edit query,
// Move up/down and Delete.
import { useEffect, useState, type FormEvent } from "react";
import type { SavedSearchView } from "../core/index.ts";
import { SAVED_SEARCH_NAME_MAX, SAVED_SEARCH_QUERY_MAX } from "../core/saved-searches.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { stopEscape } from "./shortcuts.ts";

/** A saved search's unread count as the rail shows it; capped counts read "499+". */
export function savedCount(search: Pick<SavedSearchView, "unread" | "capped">): string | null {
  if (search.capped) return "499+";
  return search.unread > 0 ? String(search.unread) : null;
}

export const SAVED_SEARCH_GONE_TEXT = "This saved search was deleted";

export function SavedSearchesRail({
  searches,
  currentId,
  onOpen,
  onMenu,
}: {
  searches: readonly SavedSearchView[];
  currentId: string | null;
  onOpen: (search: SavedSearchView) => void;
  onMenu: (search: SavedSearchView) => void;
}) {
  if (searches.length === 0) return null;
  return (
    <div className="px-1.5 py-1">
      <p className="px-2 pb-0.5 pt-1 text-xs font-medium text-muted-foreground">Saved</p>
      <ul aria-label="Saved searches" className="flex flex-col gap-px">
        {searches.map((search) => {
          const count = savedCount(search);
          const selected = search.id === currentId;
          return (
            <li key={search.id} className="group flex items-center">
              <button
                type="button"
                aria-current={selected ? "page" : undefined}
                title={search.query}
                onClick={() => onOpen(search)}
                className={cn(
                  "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                  selected && "bg-state-active hover:bg-state-active",
                )}
              >
                <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className={cn("min-w-0 flex-1 truncate", count !== null && "font-medium")}>{search.name}</span>
                {count !== null ? (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {count}
                    <span className="sr-only"> unread</span>
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                aria-label={`${search.name} options`}
                onClick={() => onMenu(search)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-state-hover focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
              >
                <Icon name="MoreHorizontal" fallback="Info" className="size-4" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Save search, Rename or Edit query. */
export type SavedSearchEdit =
  | { kind: "save"; query: string; accountId: string | null }
  | { kind: "rename" | "edit"; search: SavedSearchView };

export function SaveSearchDialog({
  request,
  onSave,
  onCancel,
}: {
  request: SavedSearchEdit | null;
  onSave: (input: { id?: string; name: string; query: string; accountId: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (request === null) return;
    const startQuery = request.kind === "save" ? request.query : request.search.query;
    setName(request.kind === "save" ? startQuery.slice(0, SAVED_SEARCH_NAME_MAX) : request.search.name);
    setQuery(startQuery);
    setProblem(null);
    setBusy(false);
  }, [request]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (request === null) return;
    const cleanName = name.trim();
    const cleanQuery = query.trim();
    if (cleanName === "" || cleanName.length > SAVED_SEARCH_NAME_MAX) {
      setProblem(`Use a name of 1 to ${SAVED_SEARCH_NAME_MAX} characters`);
      return;
    }
    if (cleanQuery === "" || cleanQuery.length > SAVED_SEARCH_QUERY_MAX) {
      setProblem(`Use a search of 1 to ${SAVED_SEARCH_QUERY_MAX} characters`);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSave(
        request.kind === "save"
          ? { name: cleanName, query: cleanQuery, accountId: request.accountId }
          : { id: request.search.id, name: cleanName, query: cleanQuery, accountId: request.search.accountId },
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const title = request?.kind === "rename" ? "Rename saved search" : request?.kind === "edit" ? "Edit saved search" : "Save search";
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Saved searches show in the rail with their unread count.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          {request?.kind !== "edit" ? (
            <Input
              aria-label="Name"
              autoFocus
              value={name}
              maxLength={SAVED_SEARCH_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
            />
          ) : null}
          {request?.kind !== "rename" ? (
            <Input
              aria-label="Search"
              autoFocus={request?.kind === "edit"}
              value={query}
              maxLength={SAVED_SEARCH_QUERY_MAX}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          {problem !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving\u2026" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
