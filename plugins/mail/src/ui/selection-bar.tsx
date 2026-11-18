// The list header: the folder's name and a "select page" box; while some
// conversations are selected it becomes the selection bar with the actions
// that apply to all of them.
import { useId } from "react";
import type { MessageAction, SpecialUse } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { tx } from "./i18n/index.ts";

/**
 * The selection after the owner toggles `id`. With `range` (shift-click) and
 * an anchor on screen, every row between them takes the clicked row's new
 * state.
 */
export function toggleSelection(
  order: readonly string[],
  selection: ReadonlySet<string>,
  id: string,
  range: boolean,
  anchor: string | null,
): Set<string> {
  const next = new Set(selection);
  const checked = !selection.has(id);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  const ids = range && from >= 0 && to >= 0 ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
  for (const item of ids) {
    if (checked) next.add(item);
    else next.delete(item);
  }
  return next;
}

export interface BarAction {
  /** A message action, or a dialog: Move to… or Snooze (slice 3e). */
  action: MessageAction | "move_to" | "snooze";
  label: string;
  icon: string;
  /** Why the action is offered but cannot run on this selection; null when it can. */
  disabledReason: string | null;
}

/** One account in the selection: whether Archive applies to its messages here. */
export interface SelectionGroup {
  accountId: string;
  archiveAllowed: boolean;
}

/**
 * The actions for a selection in a folder (or role) of this special use, by
 * the slice-2 rules: Not spam only in Spam, Spam elsewhere, Delete except in
 * Trash, Archive where the server allows it, Snooze in the Inbox. With several accounts an action
 * shows when it applies to some of them and runs only when it applies to all;
 * Move to… needs one account.
 */
export function selectionActions(
  use: SpecialUse | null,
  groups: readonly SelectionGroup[],
  state: { anyUnread: boolean; anyRead: boolean; anyFlagged: boolean; anyUnflagged: boolean },
): BarAction[] {
  const actions: BarAction[] = [];
  const ok = (action: BarAction["action"], label: string, icon: string, disabledReason: string | null = null) =>
    actions.push({ action, label, icon, disabledReason });
  if (state.anyUnread) ok("mark_read", "Mark read", "MailOpen");
  if (state.anyRead) ok("mark_unread", "Mark unread", "Mail");
  if (state.anyUnflagged) ok("flag", "Flag", "Star");
  if (state.anyFlagged) ok("unflag", "Unflag", "Star");
  const archiving = groups.filter((g) => g.archiveAllowed).length;
  if (archiving > 0) {
    ok(
      "archive",
      "Archive",
      "Archive",
      archiving < groups.length ? "Archive does not apply to every selected account here" : null,
    );
  }
  if (use === "junk") ok("not_spam", "Not spam", "SecurityCheck");
  else ok("spam", "Spam", "AlertTriangle");
  if (use !== "trash") ok("delete", "Delete", "Trash2");
  ok("move_to", "Move to…", "Folder", groups.length > 1 ? "Moving works within one account" : null);
  // Snooze takes Inbox mail only (slice 3e).
  if (use === "inbox") ok("snooze", "Snooze", "Clock");
  return actions;
}

/**
 * The bulk actions as buttons: labelled (the selection panel, in the same
 * place and style as the reading-pane toolbar) or icon-only (the narrow bar).
 * A disabled action keeps its reason as a tooltip and as its description.
 */
function ActionButtons({
  actions,
  onAction,
  pending,
  iconOnly,
}: {
  actions: readonly BarAction[];
  onAction: (action: BarAction["action"]) => void;
  pending: boolean;
  iconOnly: boolean;
}) {
  const reasonId = useId();
  return (
    <>
      {actions.map(({ action, label, icon, disabledReason }) => {
        const button = (
          <Button
            variant="ghost"
            size={iconOnly ? "icon" : "sm"}
            className={iconOnly ? "size-7 shrink-0" : undefined}
            aria-label={iconOnly ? label : undefined}
            disabled={pending || disabledReason !== null}
            aria-describedby={disabledReason !== null ? `${reasonId}-${action}` : undefined}
            onClick={() => onAction(action)}
          >
            <Icon name={icon} fallback="Folder" aria-hidden />
            {iconOnly ? null : label}
          </Button>
        );
        if (disabledReason === null) {
          return iconOnly ? (
            <span key={action} title={label} className="inline-flex shrink-0">
              {button}
            </span>
          ) : (
            <span key={action} className="inline-flex">
              {button}
            </span>
          );
        }
        return (
          <span key={action} title={disabledReason} className="inline-flex shrink-0">
            {button}
            <span id={`${reasonId}-${action}`} className="sr-only">
              {disabledReason}
            </span>
          </span>
        );
      })}
    </>
  );
}

export interface SelectionBarProps {
  /** The folder or role name, shown while nothing is selected. */
  title: string;
  /** The conversations on screen, in order. */
  pageIds: readonly string[];
  selection: ReadonlySet<string>;
  onSelectionChange: (next: ReadonlySet<string>) => void;
  /**
   * The narrow (one-column) layout only: the actions as one row of icons
   * under the header. Elsewhere the selection panel holds them; null here.
   */
  compactActions: { actions: readonly BarAction[]; onAction: (action: BarAction["action"]) => void; pending: boolean } | null;
}

/** The list header: "select page" and the folder name, or the selection count and Clear. */
export function SelectionBar({ title, pageIds, selection, onSelectionChange, compactActions }: SelectionBarProps) {
  const count = selection.size;
  const onPage = pageIds.filter((id) => selection.has(id)).length;
  const all = pageIds.length > 0 && onPage === pageIds.length;
  const checked = all ? true : count > 0 ? "indeterminate" : false;

  return (
    <div className="sticky top-0 z-10 flex shrink-0 flex-col border-b border-border bg-background">
      <div
        role={count > 0 ? "group" : undefined}
        aria-label={count > 0 ? tx("Selection") : undefined}
        className="flex min-h-9 shrink-0 items-center gap-1 px-3 py-1"
      >
        <Checkbox
          aria-label={tx("Select all on page")}
          checked={checked}
          disabled={pageIds.length === 0}
          onClick={() => onSelectionChange(all || count > 0 ? new Set() : new Set(pageIds))}
          className="mr-1"
        />
        {count === 0 ? (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{title}</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" aria-live="polite">
              {count} {tx("selected")}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={tx("Clear selection")}
              onClick={() => onSelectionChange(new Set())}
            >
              <Icon name="X" aria-hidden />
            </Button>
          </>
        )}
      </div>
      {count > 0 && compactActions !== null ? (
        <div
          role="toolbar"
          aria-label={tx("Selection actions")}
          className="flex shrink-0 flex-nowrap items-center gap-0.5 overflow-x-auto px-2 pb-1"
        >
          <ActionButtons {...compactActions} iconOnly />
        </div>
      ) : null}
    </div>
  );
}

export interface SelectionPanelProps {
  count: number;
  /** Per-account counts, shown when the selection spans several accounts. */
  perAccount: readonly { label: string; count: number }[];
  actions: readonly BarAction[];
  onAction: (action: BarAction["action"]) => void;
  pending: boolean;
}

/**
 * The right pane while a selection exists: the bulk actions where the reading
 * pane's toolbar is, and a short summary. The open conversation waits behind it.
 */
export function SelectionPanel({ count, perAccount, actions, onAction, pending }: SelectionPanelProps) {
  return (
    <div className="box-border flex w-full min-w-0 flex-1 flex-col gap-3 px-4 pb-6 pt-2">
      <div
        role="toolbar"
        aria-label={tx("Selected conversations")}
        className="flex flex-wrap items-center gap-1 border-b border-border pb-2"
      >
        <ActionButtons actions={actions} onAction={onAction} pending={pending} iconOnly={false} />
      </div>
      <div role="status" className="flex flex-1 flex-col items-center justify-center gap-1 py-10 text-center">
        <Icon name="Mail" className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">
          {count === 1 ? tx("1 conversation selected") : `${count} conversations selected`}
        </p>
        {perAccount.length > 1
          ? perAccount.map(({ label, count: n }) => (
              <p key={label} className="text-xs text-muted-foreground">
                {label}: {n}
              </p>
            ))
          : null}
      </div>
    </div>
  );
}
