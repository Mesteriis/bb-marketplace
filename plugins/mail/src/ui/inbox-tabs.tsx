// Split Inbox: the row of tabs over an Inbox list, the library of ready
// tabs, a tab's menu and the dialog that names a tab or edits its
// condition. The first tab is always the whole Inbox. The design system has
// no dropdown, so the library and a tab's menu are dialogs.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { TABS_MAX, TAB_NAME_MAX, TAB_QUERY_MAX } from "../core/inbox-tabs.ts";
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
import { ActionMenu, type MenuEntry } from "./action-menu.tsx";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

/** A tab as `inbox_tabs_list` gives it. */
export interface InboxTabView {
  id: string;
  name: string;
  query: string;
  /** Unread conversations of the tab in the scope shown. */
  unread: number;
  /** The condition no longer parses: the tab lists nothing until it is edited. */
  broken: boolean;
}

export interface TabLibraryEntry {
  id: string;
  /** A tx key. */
  name: string;
  query: string;
}

/** What a dialog of the row is open for. */
export type TabRequest =
  | { kind: "library" }
  | { kind: "new"; name: string; query: string }
  | { kind: "menu" | "rename" | "edit"; tab: InboxTabView };

export interface InboxTabsProps {
  tabs: readonly InboxTabView[];
  /** The tab in view; null is the Inbox tab. */
  currentId: string | null;
  /** Unread conversations of the whole Inbox; absent: no number on the Inbox tab. */
  inboxUnread?: number;
  library: readonly TabLibraryEntry[];
  onSelect: (id: string | null) => void;
  /** Rejects with the reason a tab was refused; the dialog shows it. */
  onAdd: (tab: { name: string; query: string }) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onEdit: (id: string, query: string) => Promise<void>;
  onMove: (id: string, direction: "left" | "right") => void;
  onRemove: (id: string) => void;
  /** A dialog asked for from outside the row (a new serial opens it). */
  ask?: { serial: number; request: TabRequest } | null;
  className?: string;
}

/** A refusal as the owner reads it; the server's texts are tx keys. */
const reasonOf = (error: unknown) => tx(error instanceof Error && error.message ? error.message : String(error));

/** Whether a ready tab's condition is already one of the owner's tabs. */
export function libraryLeft(library: readonly TabLibraryEntry[], tabs: readonly Pick<InboxTabView, "query">[]): TabLibraryEntry[] {
  const have = new Set(tabs.map((tab) => tab.query.trim().toLowerCase()));
  return library.filter((entry) => !have.has(entry.query.toLowerCase()));
}

function Count({ unread }: { unread: number }) {
  if (unread <= 0) return null;
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {unread}
      <span className="sr-only"> {tx("unread")}</span>
    </span>
  );
}

// scroll-mx: the tab in view stops short of the row's faded edge.
const TAB_CLASS =
  "flex h-7 shrink-0 scroll-mx-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

export function InboxTabs(props: InboxTabsProps) {
  const { tabs, currentId, library } = props;
  const [request, setRequest] = useState<TabRequest | null>(null);
  const askSerial = props.ask?.serial ?? null;
  useEffect(() => {
    if (props.ask !== undefined && props.ask !== null) setRequest(props.ask.request);
    // Only a new serial opens a dialog; the request object may be rebuilt each render.
  }, [askSerial]);

  // The tab in view, with its menu button, stays inside the visible part of a row that scrolls.
  const selectedRef = useRef<HTMLElement | null>(null);
  const shown = tabs.length;
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [currentId, shown]);

  const menuTab = request?.kind === "menu" ? request.tab : null;
  const menuIndex = menuTab === null ? -1 : tabs.findIndex((tab) => tab.id === menuTab.id);
  const menuEntries: MenuEntry[] = [
    { kind: "action", id: "rename", label: tx("Rename…"), icon: "Pencil" },
    { kind: "action", id: "edit", label: tx("Edit condition…"), icon: "Search" },
    { kind: "action", id: "left", label: tx("Move left"), icon: "ArrowLeft", disabled: menuIndex <= 0 },
    { kind: "action", id: "right", label: tx("Move right"), icon: "ArrowRight", disabled: menuIndex === -1 || menuIndex === tabs.length - 1 },
    { kind: "action", id: "remove", label: tx("Remove tab"), icon: "Trash2", destructive: true },
  ];
  const onMenuPick = (id: string) => {
    if (menuTab === null) return;
    if (id === "rename" || id === "edit") setRequest({ kind: id, tab: menuTab });
    else if (id === "left" || id === "right") props.onMove(menuTab.id, id);
    else if (id === "remove") props.onRemove(menuTab.id);
  };

  return (
    <>
      {tabs.length > 0 ? (
        <div className={cn("flex shrink-0 items-center gap-1 border-b border-border px-2 py-1", props.className)}>
          <div
            role="tablist"
            aria-label={tx("Inbox tabs")}
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none]"
          >
            <button
              type="button"
              role="tab"
              ref={currentId === null ? (el) => void (selectedRef.current = el) : undefined}
              aria-selected={currentId === null}
              onClick={() => props.onSelect(null)}
              className={cn(TAB_CLASS, currentId === null && "bg-state-active font-medium text-foreground hover:bg-state-active")}
            >
              <span>{tx("Inbox")}</span>
              <Count unread={props.inboxUnread ?? 0} />
            </button>
            {tabs.map((tab) => {
              const selected = tab.id === currentId;
              return (
                <span
                  key={tab.id}
                  role="none"
                  ref={selected ? (el) => void (selectedRef.current = el) : undefined}
                  className="flex shrink-0 scroll-mx-6 items-center"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    title={tab.broken ? tx("This tab's condition no longer works") : tab.query}
                    onClick={() => props.onSelect(tab.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setRequest({ kind: "menu", tab });
                    }}
                    className={cn(TAB_CLASS, selected && "bg-state-active font-medium text-foreground hover:bg-state-active")}
                  >
                    <span className="max-w-40 truncate">{tab.name}</span>
                    {tab.broken ? (
                      <>
                        <Icon name="AlertTriangle" className="size-3.5 text-warning" aria-hidden />
                        <span className="sr-only">{tx("condition no longer works")}</span>
                      </>
                    ) : (
                      <Count unread={tab.unread} />
                    )}
                  </button>
                  {selected ? (
                    <button
                      type="button"
                      aria-label={tx("{p1} options", { p1: tab.name })}
                      onClick={() => setRequest({ kind: "menu", tab })}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <Icon name="MoreHorizontal" fallback="Info" className="size-4" aria-hidden />
                    </button>
                  ) : null}
                </span>
              );
            })}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="size-7 shrink-0 p-0 text-muted-foreground"
            aria-label={tx("Add a tab")}
            onClick={() => setRequest({ kind: "library" })}
          >
            <Icon name="Plus" aria-hidden />
          </Button>
        </div>
      ) : null}
      <ActionMenu
        title={menuTab?.name ?? ""}
        {...(menuTab !== null ? { description: menuTab.broken ? tx("This tab's condition no longer works") : menuTab.query } : {})}
        entries={menuEntries}
        open={menuTab !== null}
        onPick={onMenuPick}
        onClose={() => setRequest((prev) => (prev?.kind === "menu" ? null : prev))}
      />
      <TabLibraryDialog
        open={request?.kind === "library"}
        left={libraryLeft(library, tabs)}
        full={tabs.length >= TABS_MAX}
        onAdd={props.onAdd}
        onOwn={() => setRequest({ kind: "new", name: "", query: "" })}
        onClose={() => setRequest((prev) => (prev?.kind === "library" ? null : prev))}
      />
      <TabEditDialog
        request={request !== null && request.kind !== "library" && request.kind !== "menu" ? request : null}
        onSave={async (next) => {
          if (next.kind === "new") await props.onAdd({ name: next.name, query: next.query });
          else if (next.kind === "rename") await props.onRename(next.id, next.name);
          else await props.onEdit(next.id, next.query);
          setRequest(null);
        }}
        onCancel={() => setRequest(null)}
      />
    </>
  );
}

/** The ready tabs not added yet, one click each, and the way to a tab of the owner's own. */
export function TabLibraryDialog({
  open,
  left,
  full,
  onAdd,
  onOwn,
  onClose,
}: {
  open: boolean;
  left: readonly TabLibraryEntry[];
  /** The owner has the most tabs Mail keeps. */
  full: boolean;
  onAdd: (tab: { name: string; query: string }) => Promise<void>;
  onOwn: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setBusy(null);
    setProblem(null);
  }, [open]);
  const add = async (entry: TabLibraryEntry) => {
    setBusy(entry.id);
    setProblem(null);
    try {
      await onAdd({ name: tx(entry.name), query: entry.query });
      onClose();
    } catch (error) {
      setProblem(reasonOf(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && busy === null && onClose()}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>{tx("Add a tab")}</DialogTitle>
          <DialogDescription>
            {full
              ? tx("You have the most tabs Mail keeps ({p1}). Remove one to add another.", { p1: TABS_MAX })
              : tx("A tab shows the Inbox conversations that match its condition. The Inbox tab keeps showing everything.")}
          </DialogDescription>
        </DialogHeader>
        {left.length > 0 ? (
          <ul aria-label={tx("Ready tabs")} className="flex max-h-72 flex-col gap-px overflow-y-auto">
            {left.map((entry) => (
              <li key={entry.id}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  disabled={full || busy !== null}
                  onClick={() => void add(entry)}
                >
                  {tx(entry.name)}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={full || busy !== null} onClick={onOwn}>
            {tx("Your own condition…")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type TabEditRequest = Exclude<TabRequest, { kind: "library" } | { kind: "menu"; tab: InboxTabView }>;
export type TabEditResult =
  | { kind: "new"; name: string; query: string }
  | { kind: "rename"; id: string; name: string }
  | { kind: "edit"; id: string; query: string };

/** A new tab (name and condition), Rename, or Edit condition. A refusal stays in the dialog. */
export function TabEditDialog({
  request,
  onSave,
  onCancel,
}: {
  request: TabEditRequest | null;
  onSave: (result: TabEditResult) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (request === null) return;
    setName((request.kind === "new" ? request.name : request.tab.name).slice(0, TAB_NAME_MAX));
    setQuery(request.kind === "new" ? request.query : request.tab.query);
    setProblem(null);
    setBusy(false);
  }, [request]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (request === null || busy) return;
    const cleanName = name.trim();
    const cleanQuery = query.trim();
    if (request.kind !== "edit" && cleanName === "") {
      setProblem(tx("A tab needs a name"));
      return;
    }
    if (request.kind !== "rename" && cleanQuery === "") {
      setProblem(tx("A tab needs a condition"));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSave(
        request.kind === "new"
          ? { kind: "new", name: cleanName, query: cleanQuery }
          : request.kind === "rename"
            ? { kind: "rename", id: request.tab.id, name: cleanName }
            : { kind: "edit", id: request.tab.id, query: cleanQuery },
      );
    } catch (error) {
      setProblem(reasonOf(error));
      setBusy(false);
    }
  };

  const title = request?.kind === "rename" ? tx("Rename tab") : request?.kind === "edit" ? tx("Edit tab condition") : tx("New tab");
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {request?.kind === "rename"
              ? tx("The name shows on the tab.")
              : tx("Anything you can search by, for example from:ada@example.com, category:newsletters -is:dev or a word.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          {request?.kind !== "edit" ? (
            <Input aria-label={tx("Name")} autoFocus value={name} maxLength={TAB_NAME_MAX} onChange={(event) => setName(event.target.value)} />
          ) : null}
          {request?.kind !== "rename" ? (
            <Input
              aria-label={tx("Condition")}
              autoFocus={request?.kind === "edit"}
              value={query}
              maxLength={TAB_QUERY_MAX}
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
              {tx("Cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? tx("Saving…") : tx("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
