// The Mail page: header (search, sync), the conversation list and the reading
// pane. The folder rail lives in the host's sidebar (mail-sidebar.tsx). Data
// and actions arrive through props; nothing here knows the host, so the same
// page renders in BB and in any other shell.
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import type {
  Account,
  AttachmentMeta,
  DraftView,
  Folder,
  MessageAction,
  MessageHeader,
  MessageSummary,
  NewAccountInput,
  OutboxRow,
  SpecialUse,
  StatusView,
  ThreadDetail,
  ThreadSummary,
} from "../core/index.ts";
import { archiveAllowedFrom, ROLE_NAMES, roleFolders } from "../core/actions.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AccountForm, type AccountFormInitial, type AccountFormProps } from "./account-form.tsx";
import { Composer, type ComposerPorts, type ComposeWarningKind } from "./composer.tsx";
import { DetailsPanel, type DetailsState } from "./details-panel.tsx";
import {
  EmptyFolder,
  LoadingState,
  NoSearchResults,
  NothingSelected,
  SyncingState,
  VaultNotReady,
} from "./empty-states.tsx";
import {
  accountLabel,
  ALL_ACCOUNTS,
  viewPaths,
  type MailView,
  type RoleName,
} from "./folder-list.tsx";
import { MoveDialog } from "./move-dialog.tsx";
import { OutboxSection, type OutboxAction } from "./outbox.tsx";
import { messageToHand, ReadingPane, type BodyState, type ReadingTranslation } from "./reading-pane.tsx";
import {
  SelectionBar,
  SelectionPanel,
  selectionActions,
  toggleSelection,
  type BarAction,
  type SelectionGroup,
} from "./selection-bar.tsx";
import { ShortcutSheet } from "./shortcut-sheet.tsx";
import { SmtpDialog, type SmtpResult, type SmtpSettingsInput } from "./smtp-dialog.tsx";
import {
  createDestructiveGuard,
  useShortcuts,
  type DestructiveGuard,
  type GoTarget,
  type ShortcutCommand,
} from "./shortcuts.ts";
import { formatListDate, SearchResultList, ThreadList } from "./thread-list.tsx";

export { ALL_ACCOUNTS };

export interface ThreadListState {
  threads: ThreadSummary[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export interface SearchState {
  /** The query the hits answer; empty when no search is active. */
  query: string;
  hits: MessageSummary[];
  loading: boolean;
  error: string | null;
}

export interface ReadingState {
  threadId: string | null;
  detail: ThreadDetail | null;
  loading: boolean;
  error: string | null;
  expandedIds: ReadonlySet<string>;
  bodies: Readonly<Record<string, BodyState>>;
  /** Messages whose remote images the owner chose to show this time. */
  remoteImageIds: ReadonlySet<string>;
  /** Lowercased senders the owner allowed while this conversation was open. */
  imageSenders: ReadonlySet<string>;
}

/** null: the form is closed; otherwise what it opens with. */
export type AccountFormRequest = { initial?: AccountFormInitial } | null;

/** The open composer. */
export interface ComposerState {
  draft: DraftView;
  warning: ComposeWarningKind;
  /** Addresses compose_prepare left out of the recipients. */
  dropped: string[];
  /** The conversation a reply or forward came from: it docks under it in two columns. */
  dockThreadId: string | null;
}

export type ComposeKind = "reply" | "reply_all" | "forward";

export interface MailPageProps {
  /** null while the first load is in flight. */
  status: StatusView | null;
  statusError: string | null;
  /** The chosen account; null in All accounts (or before there is one). */
  account: Account | null;
  /** All accounts is chosen. */
  unified: boolean;
  /** An account id, or ALL_ACCOUNTS. */
  onSelectAccount: (choice: string) => void;
  /** The account's folders (every account's in All accounts); null while they load. */
  folders: Folder[] | null;
  /** What the list shows. */
  view: MailView;
  onSelectView: (view: MailView) => void;
  list: ThreadListState;
  onLoadMore: () => void;
  search: SearchState;
  onSearch: (query: string) => void;
  syncing: boolean;
  onSync: () => void;
  reading: ReadingState;
  onSelectThread: (threadId: string, messageId: string | null, accountId: string) => void;
  onCloseThread: () => void;
  onToggleMessage: (messageId: string) => void;
  onOpenLink: (url: string) => void;
  onHandToAgent: (message: MessageHeader) => void;
  /** Checked conversations of the list. */
  selection: ReadonlySet<string>;
  onSelectionChange: (next: ReadonlySet<string>) => void;
  /** An action on conversations' messages in the view; `destination` goes with move. */
  onThreadsAction: (threadIds: string[], action: MessageAction, destination?: string) => void;
  /** An action is in flight; the buttons wait. */
  actionPending: boolean;
  /** The row star: flag the newest message in the view, or unflag the flagged ones. */
  onToggleThreadFlag: (threadId: string) => void;
  onToggleMessageFlag: (message: MessageHeader) => void;
  details: DetailsState | null;
  onOpenDetails: (message: MessageHeader) => void;
  onCloseDetails: () => void;
  onCopy: (text: string) => Promise<boolean>;
  onDownloadEml: (message: MessageHeader) => void;
  onDownloadAttachment: (message: MessageHeader, attachment: AttachmentMeta) => void;
  onShowImages: (messageId: string) => void;
  onAlwaysShowImages: (message: MessageHeader) => void;
  onStopImages: (message: MessageHeader) => void;
  accountForm: AccountFormRequest;
  onOpenAccountForm: (request: { initial?: AccountFormInitial }) => void;
  onCloseAccountForm: () => void;
  onTestAccount: (input: NewAccountInput) => Promise<{ ok: boolean; reason: string | null }>;
  onSaveAccount: (input: NewAccountInput) => Promise<void>;
  ExternalLink: AccountFormProps["ExternalLink"];
  /** The open composer, or null. */
  composer: ComposerState | null;
  composerPorts: ComposerPorts;
  /** New message (c, the rail's New message). */
  onCompose: () => void;
  /** Reply, Reply all or Forward (toolbar, r, a, f). */
  onReply: (kind: ComposeKind, message: MessageHeader) => void;
  /** Continue a draft message in the composer. */
  onEditDraft: (message: MessageHeader) => void;
  /** Enter or o on a row of a Drafts folder: its newest draft opens in the composer. */
  onEditDraftThread: (threadId: string, accountId: string) => void;
  onCloseComposer: () => void;
  onSent: (outbox: { outboxId: string; sendAfter: string }) => void;
  /** Sends not done yet (every account). */
  outbox: readonly OutboxRow[];
  /** Outbox rows with an action in flight. */
  outboxPending: ReadonlySet<string>;
  onOutboxAction: (row: OutboxRow, action: OutboxAction) => void;
  /** The account whose SMTP dialog is open, or null. */
  smtpAccountId: string | null;
  onOpenSmtp: (accountId: string) => void;
  onCloseSmtp: () => void;
  onTestSmtp: (input: SmtpSettingsInput) => Promise<SmtpResult>;
  onSaveSmtp: (input: SmtpSettingsInput) => Promise<SmtpResult>;
  /** Changes when focus should come to the page (a pick in the host's sidebar). */
  focusRequest?: number;
  /** Translate in the reading pane (slice 3c); absent: no Translate. */
  translation?: ReadingTranslation;
}

function PageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {children}
      </div>
    </div>
  );
}

export function MailPage(props: MailPageProps) {
  const { status, statusError, accountForm } = props;

  if (statusError !== null) {
    return (
      <PageFrame>
        <p role="alert" className="text-sm text-destructive">
          {statusError}
        </p>
      </PageFrame>
    );
  }
  if (status === null) {
    return (
      <PageFrame>
        <LoadingState label="Loading mail…" />
      </PageFrame>
    );
  }
  if (!status.vaultReady) {
    return (
      <PageFrame>
        <VaultNotReady />
      </PageFrame>
    );
  }
  if (status.accounts.length === 0 || accountForm !== null) {
    const first = status.accounts.length === 0;
    return (
      <PageFrame>
        <AccountForm
          key={accountForm?.initial?.email ?? "new"}
          title={
            first
              ? "Connect your mailbox"
              : accountForm?.initial
                ? `Reconnect ${accountForm.initial.email}`
                : "Add an account"
          }
          initial={accountForm?.initial}
          onTest={props.onTestAccount}
          onSave={props.onSaveAccount}
          onCancel={first ? undefined : props.onCloseAccountForm}
          ExternalLink={props.ExternalLink}
        />
      </PageFrame>
    );
  }
  return <Mailbox {...props} status={status} />;
}


/** Actions that take a conversation out of the list it is in. */
const REMOVING_ACTIONS: ReadonlySet<MessageAction> = new Set(["archive", "delete", "spam", "not_spam", "move"]);

/** The page's own @3xl breakpoint (48rem): below it, one column. */
const WIDE_MIN_PX = 768;

/**
 * Whether the page is two columns wide, measured on its root like the
 * container queries. Without ResizeObserver it counts as wide.
 */
function useWideLayout(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined && width > 0) setWide(width >= WIDE_MIN_PX);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}

/** Short, distinct labels for the account marker on rows in All accounts. */
export function accountMarkers(accounts: readonly Account[]): Map<string, string> {
  const short = (account: Account) =>
    account.displayName?.trim() || account.email.split("@")[1]?.split(".")[0] || account.email;
  const labels = accounts.map(short);
  return new Map(
    accounts.map((account, index) => [
      account.id,
      labels.filter((label) => label === labels[index]).length > 1 ? account.email : labels[index]!,
    ]),
  );
}

/** What the page knows about the view, for the list, the bar and the reading pane. */
interface ViewModel {
  title: string;
  use: SpecialUse | null;
  foldersOf: (accountId: string) => Folder[];
  /** Paths of the account's folders the view covers. */
  pathsOf: (accountId: string) => string[];
  inView: (message: MessageHeader) => boolean;
  archiveAllowed: (accountId: string) => boolean;
  folderName: (accountId: string, path: string) => string;
}

function viewModel(props: MailPageProps & { status: StatusView }): ViewModel {
  const { view, status } = props;
  const all = props.folders ?? [];
  const foldersOf = (accountId: string) => all.filter((f) => f.accountId === accountId);
  const folderName = (accountId: string, path: string) =>
    foldersOf(accountId).find((f) => f.path === path)?.name ?? (path === "INBOX" ? "Inbox" : path);
  const use: SpecialUse | null =
    view.kind === "role"
      ? view.role
      : (foldersOf(view.accountId).find((f) => f.path === view.path)?.specialUse ??
        (view.path === "INBOX" ? "inbox" : null));
  const pathsOf = (accountId: string) => viewPaths(view, all, accountId);
  return {
    title: view.kind === "role" ? ROLE_NAMES[view.role] : folderName(view.accountId, view.path),
    use,
    foldersOf,
    pathsOf,
    inView: (message) => pathsOf(message.accountId).includes(message.folder),
    archiveAllowed: (accountId) => {
      const account = status.accounts.find((a) => a.id === accountId);
      return account !== undefined && archiveAllowedFrom(use, foldersOf(accountId), account.preset);
    },
    folderName,
  };
}

/** The view `g` then a letter goes to; null when there is none. */
function goView(props: MailPageProps, model: ViewModel, target: Exclude<GoTarget, "all">): MailView | null {
  const role: RoleName = target;
  if (props.unified) return { kind: "role", role };
  const account = props.account;
  if (account === null) return null;
  const folder = roleFolders(role, model.foldersOf(account.id)).find((f) => f.selectable);
  if (folder !== undefined) return { kind: "folder", accountId: account.id, path: folder.path };
  return role === "inbox" ? { kind: "folder", accountId: account.id, path: "INBOX" } : null;
}

function Mailbox(props: MailPageProps & { status: StatusView }) {
  const { status, reading, list, search, selection } = props;
  const model = viewModel(props);
  const threadOpen = reading.threadId !== null;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const anchor = useRef<string | null>(null);
  const guardRef = useRef<DestructiveGuard | null>(null);
  guardRef.current ??= createDestructiveGuard();
  const destructiveGuard = guardRef.current;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [moveTargets, setMoveTargets] = useState<string[] | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  // A composer that closed while focused leaves no focus behind.
  const composerId = props.composer?.draft.id ?? null;
  useEffect(() => {
    if (composerId === null) setComposerFocused(false);
  }, [composerId]);
  const searching = search.query !== "";
  const selecting = selection.size > 0;
  const wide = useWideLayout(rootRef);
  const markers = accountMarkers(status.accounts);
  const marker = (accountId: string) => (props.unified ? (markers.get(accountId) ?? null) : null);
  /** Ours (a server copy of a compose draft), or any message in a Drafts folder. */
  const isDraft = (message: MessageHeader) =>
    message.draftId !== null ||
    model.foldersOf(message.accountId).find((f) => f.path === message.folder)?.specialUse === "drafts";

  /** The hotkeys listen on the page root: focus that fell out of it (to body) silences them. */
  const focusLost = () => {
    const active = document.activeElement;
    return active === null || active === document.body || !active.isConnected;
  };
  const focusRowElement = (id: string): boolean => {
    const rows = rootRef.current?.querySelectorAll<HTMLElement>("[data-row-key]");
    for (const element of rows === undefined ? [] : Array.from(rows)) {
      if (element.dataset.rowKey === id) {
        element.focus({ preventScroll: true });
        element.scrollIntoView?.({ block: "nearest" });
        return true;
      }
    }
    return false;
  };
  const focusRoot = () => rootRef.current?.focus({ preventScroll: true });

  // The page takes focus when it opens with nothing else focused, so the hotkeys work at once.
  useEffect(() => {
    if (focusLost()) focusRoot();
  }, []);

  /** Where focus goes back to when a plugin dialog closes: what opened it, else the page. */
  const opener = useRef<HTMLElement | null>(null);
  const rememberOpener = () => {
    const active = document.activeElement;
    opener.current =
      active instanceof HTMLElement && rootRef.current?.contains(active) ? active : null;
  };
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    const element = opener.current;
    opener.current = null;
    if (element !== null && element.isConnected) element.focus({ preventScroll: true });
    else focusRoot();
  };
  /** The drawer layout has no close-focus event; anything left unfocused goes to the page. */
  const afterClose = () => {
    if (focusLost()) restoreFocus(new Event("close"));
  };

  const rowIds = searching ? search.hits.map((h) => h.id) : list.threads.map((t) => t.id);
  const rowKey = rowIds.join("\n");

  // An action took the cursor row off the list: the next row (else the previous) takes the cursor.
  const shownRows = useRef<string[]>(rowIds);
  useEffect(() => {
    const before = shownRows.current;
    shownRows.current = rowIds;
    if (focusedId === null || rowIds.includes(focusedId)) return;
    const at = before.indexOf(focusedId);
    const next =
      at < 0
        ? null
        : (before.slice(at + 1).find((id) => rowIds.includes(id)) ??
          before
            .slice(0, at)
            .reverse()
            .find((id) => rowIds.includes(id)) ??
          null);
    setFocusedId(next);
    if (focusLost() && (next === null || !focusRowElement(next))) focusRoot();
    // rowKey stands for rowIds.
  }, [rowKey]);

  /** Focus that fell out of the page goes to the cursor row, else the page root. */
  const refocusIfLost = () => {
    if (!focusLost()) return;
    if (focusedId === null || !focusRowElement(focusedId)) focusRoot();
  };

  // A selection-bar action clicked with the mouse: its button unmounts with the bar.
  const selectionEmpty = selection.size === 0;
  useEffect(() => {
    if (selectionEmpty || !props.actionPending) refocusIfLost();
  }, [selectionEmpty, props.actionPending]);

  // A folder or account picked in the sidebar: focus comes to the page, so
  // the hotkeys work without a click.
  const focusRequest = props.focusRequest ?? 0;
  const handledFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === handledFocusRequest.current) return;
    handledFocusRequest.current = focusRequest;
    if (focusedId === null || !focusRowElement(focusedId)) focusRoot();
  }, [focusRequest]);

  // Back to the list (u, Back, Mark unread, an action): focus returns to the cursor row.
  const wasOpen = useRef(threadOpen);
  useEffect(() => {
    const closed = wasOpen.current && !threadOpen;
    wasOpen.current = threadOpen;
    if (!closed || !focusLost()) return;
    if (focusedId === null || !focusRowElement(focusedId)) focusRoot();
  }, [threadOpen]);
  const accountOfThread = (threadId: string): string | null =>
    list.threads.find((t) => t.id === threadId)?.accountId ??
    (reading.detail?.thread.id === threadId ? reading.detail.thread.accountId : null);
  const groupsOf = (threadIds: readonly string[]): SelectionGroup[] => {
    const accounts = new Set<string>();
    for (const id of threadIds) {
      const accountId = accountOfThread(id);
      if (accountId !== null) accounts.add(accountId);
    }
    return [...accounts].map((accountId) => ({ accountId, archiveAllowed: model.archiveAllowed(accountId) }));
  };
  const selected = list.threads.filter((t) => selection.has(t.id));
  const perAccount = status.accounts
    .map((a) => ({ label: accountLabel(a), count: selected.filter((t) => t.accountId === a.id).length }))
    .filter((entry) => entry.count > 0);
  const barActions = selectionActions(model.use, groupsOf([...selection]), {
    anyUnread: selected.some((t) => t.unreadCount > 0),
    anyRead: selected.some((t) => t.unreadCount < t.messageCount),
    anyFlagged: selected.some((t) => t.flagged),
    anyUnflagged: selected.some((t) => !t.flagged),
  });

  /**
   * What an action key acts on follows the visible toolbar: the selection
   * (its panel hides the open conversation), else the open conversation,
   * else the cursor row.
   */
  const targets = (): string[] => {
    if (selection.size > 0) return [...selection];
    if (reading.threadId !== null) {
      const messages = reading.detail?.messages ?? [];
      return messages.some(model.inView) ? [reading.threadId] : [];
    }
    if (!searching && focusedId !== null && rowIds.includes(focusedId)) return [focusedId];
    return [];
  };
  /** Runs `action` on `ids` when it applies to every account among them. */
  const runIfAllowed = (ids: string[], action: MessageAction) => {
    if (ids.length === 0) return;
    const all = { anyUnread: true, anyRead: true, anyFlagged: true, anyUnflagged: true };
    const offered = selectionActions(model.use, groupsOf(ids), all).find((a) => a.action === action);
    if (offered === undefined || offered.disabledReason !== null || props.actionPending) return;
    runAction(ids, action);
  };
  /** An action that takes mail out of the list quiets the destructive keys for a moment. */
  const runAction = (ids: string[], action: MessageAction, destination?: string) => {
    if (REMOVING_ACTIONS.has(action)) destructiveGuard.ran();
    if (destination === undefined) props.onThreadsAction(ids, action);
    else props.onThreadsAction(ids, action, destination);
  };

  const openRow = (id: string) => {
    if (searching) {
      const hit = search.hits.find((h) => h.id === id);
      if (hit !== undefined) props.onSelectThread(hit.threadId, hit.id, hit.accountId);
      return;
    }
    const thread = list.threads.find((t) => t.id === id);
    if (thread !== undefined) props.onSelectThread(thread.id, null, thread.accountId);
  };
  const focusRow = (id: string) => {
    setFocusedId(id);
    focusRowElement(id);
  };
  /** A held j/k (`repeat`) only moves the cursor: passing a conversation never opens it. */
  const step = (delta: 1 | -1, repeat: boolean) => {
    if (rowIds.length === 0) return;
    const current = focusedId === null ? -1 : rowIds.indexOf(focusedId);
    const nextIndex = current < 0 ? 0 : Math.min(Math.max(current + delta, 0), rowIds.length - 1);
    const next = rowIds[nextIndex]!;
    focusRow(next);
    // Behind the selection panel nothing opens (it would be marked read unseen).
    if (threadOpen && !repeat && !selecting) openRow(next);
  };
  /**
   * A row click (or o/Enter on the cursor row). With a selection: in one
   * column it toggles the row's checkbox (Gmail on phones); in two columns it
   * ends the selection and opens the row, as Apple Mail does.
   */
  const activateRow = (id: string) => {
    if (selecting && !searching) {
      if (!wide) {
        toggleChecked(id, false);
        return;
      }
      props.onSelectionChange(new Set());
    }
    openRow(id);
  };
  const toggleChecked = (id: string, range: boolean) => {
    props.onSelectionChange(toggleSelection(rowIds, selection, id, range, anchor.current));
    anchor.current = id;
  };
  const flagTargets = () => {
    const ids = targets();
    if (ids.length === 0) return;
    if (selection.size === 0) {
      props.onToggleThreadFlag(ids[0]!);
      return;
    }
    const allFlagged = ids.every((id) => list.threads.find((t) => t.id === id)?.flagged === true);
    props.onThreadsAction(ids, allFlagged ? "unflag" : "flag");
  };
  const openMove = (ids: string[]) => {
    if (ids.length === 0) return;
    destructiveGuard.ran();
    rememberOpener();
    setMoveTargets(ids);
  };

  const onKeyDown = useShortcuts((command: ShortcutCommand, repeat: boolean) => {
    // A quick second tap after an action must not reach the cursor row.
    if (!destructiveGuard.admit(command)) return;
    switch (command.kind) {
      case "next":
        return step(1, repeat);
      case "previous":
        return step(-1, repeat);
      case "open":
        if (focusedId === null || !rowIds.includes(focusedId)) return;
        if (model.use === "drafts" && !searching && !selecting) {
          const thread = list.threads.find((t) => t.id === focusedId);
          if (thread !== undefined) return props.onEditDraftThread(thread.id, thread.accountId);
        }
        activateRow(focusedId);
        return;
      case "compose":
        return props.onCompose();
      case "reply":
      case "reply_all":
      case "forward": {
        if (!threadOpen || selecting || reading.detail === null) return;
        const message = messageToHand(reading.detail.messages, reading.expandedIds);
        if (message !== null && !isDraft(message)) props.onReply(command.kind, message);
        return;
      }
      case "translate": {
        if (!threadOpen || selecting || reading.detail === null || props.translation === undefined) return;
        if (props.translation.disabledReason !== null) return;
        const message = messageToHand(reading.detail.messages, reading.expandedIds);
        if (message !== null && !isDraft(message)) props.translation.onToggle(message);
        return;
      }
      case "back":
        if (threadOpen) props.onCloseThread();
        return;
      case "select":
        // In one column an open conversation hides the list: x does nothing there.
        if (!(threadOpen && !wide) && !searching && focusedId !== null && rowIds.includes(focusedId)) toggleChecked(focusedId, false);
        return;
      case "archive":
        return runIfAllowed(targets(), "archive");
      case "delete":
        return runIfAllowed(targets(), "delete");
      case "spam":
        return runIfAllowed(targets(), "spam");
      case "mark_unread":
        return runIfAllowed(targets(), "mark_unread");
      case "mark_read":
        return runIfAllowed(targets(), "mark_read");
      case "flag":
        return flagTargets();
      case "move":
        return openMove(targets());
      case "search":
        searchRef.current?.focus();
        return;
      case "sheet":
        rememberOpener();
        setSheetOpen(true);
        return;
      case "go": {
        if (command.target === "all") {
          if (status.accounts.length > 1) props.onSelectAccount(ALL_ACCOUNTS);
          return;
        }
        const next = goView(props, model, command.target);
        if (next !== null) props.onSelectView(next);
        return;
      }
    }
  });

  const onBarAction = (action: BarAction["action"]) => {
    if (action === "move_to") openMove([...selection]);
    else runAction([...selection], action);
  };

  const outboxShown = props.outbox.filter(
    (row) => props.unified || row.accountId === props.account?.id,
  );
  const composer = props.composer;
  const composerView =
    composer !== null ? (
      <Composer
        key={composer.draft.id}
        draft={composer.draft}
        accounts={status.accounts}
        ports={props.composerPorts}
        warning={composer.warning}
        dropped={composer.dropped}
        layout={wide ? "panel" : "page"}
        onClose={props.onCloseComposer}
        onSent={props.onSent}
        onOpenSmtpSettings={props.onOpenSmtp}
        onFocusWithin={setComposerFocused}
      />
    ) : null;
  const docked = composer !== null && composer.dockThreadId !== null && composer.dockThreadId === reading.threadId;

  const moveAccounts = new Set(
    (moveTargets ?? []).map(accountOfThread).filter((id): id is string => id !== null),
  );
  const moveAccount = moveAccounts.size === 1 ? [...moveAccounts][0]! : null;
  const openAccount = reading.detail?.thread.accountId ?? null;
  const errors = status.accounts.filter(
    (a) => a.lastError !== null && (props.unified || a.id === props.account?.id),
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="@container flex h-full min-h-0 flex-1 flex-col outline-none"
    >
      {composerView !== null && !wide ? (
        <div className="flex min-h-0 flex-1 flex-col">{composerView}</div>
      ) : (
      <>
      <MailHeader {...props} searchRef={searchRef} onShowShortcuts={() => {
          rememberOpener();
          setSheetOpen(true);
        }}
      />
      {errors.map((account) => (
        <div
          key={account.id}
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1">
            {props.unified ? `${accountLabel(account)}: ` : ""}
            {account.lastError}
          </span>
          {account.authFailed ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                props.onOpenAccountForm({
                  initial: {
                    preset: account.preset,
                    email: account.email,
                    host: account.host,
                    port: account.port,
                  },
                })
              }
            >
              Update app password
            </Button>
          ) : null}
        </div>
      ))}
      <div className="flex min-h-0 flex-1">
        <section
          aria-label={model.title}
          className={cn(
            "min-h-0 w-full shrink-0 flex-col overflow-y-auto @3xl:flex @3xl:w-80 @3xl:border-r @3xl:border-border @6xl:w-96",
            threadOpen && !selecting ? "hidden" : "flex",
          )}
        >
          {!searching ? (
            <SelectionBar
              title={model.title}
              pageIds={list.threads.map((t) => t.id)}
              selection={selection}
              onSelectionChange={props.onSelectionChange}
              compactActions={
                wide ? null : { actions: barActions, onAction: onBarAction, pending: props.actionPending }
              }
            />
          ) : null}
          {model.use === "sent" && !searching ? (
            <OutboxSection
              rows={outboxShown}
              onAction={props.onOutboxAction}
              pending={props.outboxPending}
              marker={marker}
            />
          ) : null}
          <ListColumn
            {...props}
            focusedId={focusedId}
            marker={marker}
            onOpenRow={(id) => {
              setFocusedId(id);
              activateRow(id);
            }}
            onToggleChecked={toggleChecked}
            emptyName={model.title}
          />
        </section>
        <section
          aria-label="Conversation"
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @3xl:flex",
            threadOpen && !selecting ? "flex" : "hidden",
          )}
        >
          {composerView !== null && !docked ? (
            <div className="flex min-h-[28rem] flex-1 flex-col p-3">{composerView}</div>
          ) : selecting && wide && composerView === null ? (
            <SelectionPanel
              count={selection.size}
              perAccount={perAccount}
              actions={barActions}
              onAction={onBarAction}
              pending={props.actionPending}
            />
          ) : threadOpen ? (
            <>
            <ReadingPane
              detail={reading.detail}
              loading={reading.loading}
              error={reading.error}
              expandedIds={reading.expandedIds}
              bodies={reading.bodies}
              onToggleMessage={props.onToggleMessage}
              onOpenLink={props.onOpenLink}
              onHandToAgent={props.onHandToAgent}
              onBack={props.onCloseThread}
              inView={model.inView}
              folderUse={model.use}
              archiveAllowed={openAccount !== null && model.archiveAllowed(openAccount)}
              folderName={(message) => model.folderName(message.accountId, message.folder)}
              onAction={(action) => {
                if (reading.threadId !== null) runAction([reading.threadId], action);
              }}
              onMarkUnread={() => {
                if (reading.threadId !== null) props.onThreadsAction([reading.threadId], "mark_unread");
              }}
              onMoveTo={() => openMove(reading.threadId !== null ? [reading.threadId] : [])}
              actionPending={props.actionPending}
              onToggleMessageFlag={props.onToggleMessageFlag}
              onDetails={(message) => {
                rememberOpener();
                props.onOpenDetails(message);
              }}
              onDownloadEml={props.onDownloadEml}
              onDownloadAttachment={props.onDownloadAttachment}
              remoteImageIds={reading.remoteImageIds}
              imageSenders={reading.imageSenders}
              onShowImages={props.onShowImages}
              onAlwaysShowImages={props.onAlwaysShowImages}
              onStopImages={props.onStopImages}
              onCompose={props.onReply}
              isDraft={isDraft}
              onEditDraft={props.onEditDraft}
              hideToolbar={docked && composerFocused}
              translation={props.translation}
            />
            {docked ? <div className="flex min-h-[24rem] flex-col px-4 pb-6">{composerView}</div> : null}
            </>
          ) : (
            <NothingSelected />
          )}
        </section>
      </div>
      </>
      )}
      <MoveDialog
        open={moveTargets !== null}
        onOpenChange={(open) => {
          if (!open) setMoveTargets(null);
        }}
        folders={props.folders ?? []}
        accountId={moveAccount}
        sources={moveAccount === null ? [] : model.pathsOf(moveAccount)}
        onMove={(destination) => {
          const ids = moveTargets ?? [];
          setMoveTargets(null);
          runAction(ids, "move", destination);
        }}
        onCloseAutoFocus={restoreFocus}
        onAfterCloseAutoFocus={afterClose}
      />
      <DetailsPanel
        details={props.details}
        onClose={props.onCloseDetails}
        onCopy={props.onCopy}
        onCloseAutoFocus={restoreFocus}
        onAfterCloseAutoFocus={afterClose}
      />
      <SmtpDialog
        account={status.accounts.find((a) => a.id === props.smtpAccountId) ?? null}
        onClose={props.onCloseSmtp}
        onTest={props.onTestSmtp}
        onSave={props.onSaveSmtp}
      />
      <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} onCloseAutoFocus={restoreFocus}
        onAfterCloseAutoFocus={afterClose} />
    </div>
  );
}

function ListColumn(
  props: MailPageProps & {
    status: StatusView;
    focusedId: string | null;
    marker: (accountId: string) => string | null;
    onOpenRow: (id: string) => void;
    onToggleChecked: (id: string, range: boolean) => void;
    emptyName: string;
  },
) {
  const { status, list, search, reading } = props;
  const emailOf = (accountId: string) => status.accounts.find((a) => a.id === accountId)?.email ?? null;

  if (search.query !== "") {
    if (search.error !== null) {
      return <ListMessage role="alert" text={search.error} />;
    }
    if (search.loading && search.hits.length === 0) return <ListMessage text="Searching…" />;
    if (search.hits.length === 0) return <NoSearchResults query={search.query} />;
    return (
      <SearchResultList
        hits={search.hits}
        selectedThreadId={reading.threadId}
        marker={props.marker}
        onSelect={(hit) => props.onOpenRow(hit.id)}
        focusedId={props.focusedId}
      />
    );
  }

  if (list.error !== null && list.threads.length === 0) {
    return <ListMessage role="alert" text={list.error} />;
  }
  if (list.loading && list.threads.length === 0) return <ListMessage text="Loading mail…" />;
  if (list.threads.length === 0) {
    const shown = props.unified ? status.accounts : props.account !== null ? [props.account] : [];
    // The banner above already shows lastError; the folder is simply empty.
    const clean = shown.every((a) => a.lastError === null);
    if (clean && (props.syncing || shown.some((a) => a.lastSyncAt === null))) {
      return <SyncingState />;
    }
    return <EmptyFolder name={props.emptyName} />;
  }
  return (
    <ThreadList
      threads={list.threads}
      selectedThreadId={reading.threadId}
      ownAddress={emailOf}
      marker={props.marker}
      onSelect={(thread) => props.onOpenRow(thread.id)}
      hasMore={list.nextCursor !== null}
      loadingMore={list.loadingMore}
      onLoadMore={props.onLoadMore}
      checked={props.selection}
      onToggleChecked={props.onToggleChecked}
      onToggleFlag={props.onToggleThreadFlag}
      focusedId={props.focusedId}
    />
  );
}

function ListMessage({ text, role = "status" }: { text: string; role?: "status" | "alert" }) {
  return (
    <p
      role={role}
      className={cn("px-3 py-4 text-sm", role === "alert" ? "text-destructive" : "text-muted-foreground")}
    >
      {text}
    </p>
  );
}

/** "Synced …" for the account, or the stalest of all accounts. */
function syncLabel(accounts: readonly Account[], syncing: boolean): string {
  if (syncing) return "Syncing…";
  if (accounts.length === 0 || accounts.some((a) => a.lastSyncAt === null)) return "Not synced yet";
  const oldest = accounts.map((a) => a.lastSyncAt!).sort()[0]!;
  return `Synced ${formatListDate(oldest)}`;
}

function MailHeader(
  props: MailPageProps & {
    status: StatusView;
    searchRef: RefObject<HTMLInputElement | null>;
    onShowShortcuts: () => void;
  },
) {
  const [draft, setDraft] = useState(props.search.query);

  // The page may end a search (a folder was chosen); the box follows.
  useEffect(() => {
    setDraft(props.search.query);
  }, [props.search.query]);

  function submit(event: FormEvent) {
    event.preventDefault();
    props.onSearch(draft.trim());
  }

  function clear() {
    setDraft("");
    props.onSearch("");
  }

  const shown = props.unified ? props.status.accounts : props.account !== null ? [props.account] : [];
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <form role="search" onSubmit={submit} className="flex min-w-40 flex-1 items-center gap-1">
        <Input
          ref={props.searchRef}
          type="search"
          aria-label="Search mail"
          placeholder="Search mail — from:, subject:, is:unread"
          value={draft}
          maxLength={500}
          onChange={(event) => setDraft(event.target.value)}
          className="h-8"
        />
        {props.search.query !== "" ? (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        ) : null}
      </form>

      <span className="text-xs text-muted-foreground">{syncLabel(shown, props.syncing)}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sync now"
        disabled={props.syncing}
        onClick={props.onSync}
      >
        <Icon name="RotateCcw" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Keyboard shortcuts"
        onClick={props.onShowShortcuts}
      >
        <Icon name="Keyboard" fallback="Info" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="New message"
        className="@4xl:hidden"
        onClick={props.onCompose}
      >
        <Icon name="Pencil" fallback="Plus" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Add account"
        onClick={() => props.onOpenAccountForm({})}
      >
        <Icon name="Plus" aria-hidden />
      </Button>
    </header>
  );
}
