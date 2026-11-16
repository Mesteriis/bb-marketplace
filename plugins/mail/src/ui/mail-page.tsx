// The Mail page: header (search, sync), the conversation list and the reading
// pane. The folder rail lives in the host's sidebar (mail-sidebar.tsx). Data
// and actions arrive through props; nothing here knows the host, so the same
// page renders in BB and in any other shell.
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import type {
  Account,
  AttachmentMatch,
  AttachmentMeta,
  DraftView,
  Folder,
  MessageAction,
  MessageHeader,
  MessageSummary,
  NewAccountInput,
  OutboxRow,
  SearchField,
  SearchNote,
  SenderCard,
  SpecialUse,
  StatusView,
  ThreadDetail,
  ThreadSummary,
} from "../core/index.ts";
import type { IdentityView, ReminderView, UnsubscribeInfoView } from "../core/model.ts";
import { archiveAllowedFrom, ROLE_NAMES, roleFolders } from "../core/actions.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AccountForm, type AccountFormInitial, type AccountFormProps } from "./account-form.tsx";
import { Composer, type ComposerPorts, type ComposeWarningKind } from "./composer.tsx";
import type { TemplateView } from "./mail-settings.tsx";
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
import { BlockDialog, type BlockCheck, type BlockChoice } from "./block-dialog.tsx";
import { MoveDialog } from "./move-dialog.tsx";
import type { AiJobPorts } from "./ai-job.ts";
import type { AiCitation } from "./ai-text.tsx";
import { AskPanel, ASK_QUESTION_MAX } from "./ask-panel.tsx";
import { CategoryChip, type Category } from "./category-chips.tsx";
import { RemindDialog, ReminderStrip } from "./reminder-strip.tsx";
import { useBbDialogs, type MailBbPorts } from "./bb-dialogs.tsx";
import { RuleStrip } from "./rule-strip.tsx";
import { SummaryBlock } from "./summary-block.tsx";
import { TasksDialog, type TaskPick } from "./tasks-dialog.tsx";
import { SnoozeMenu } from "./snooze-menu.tsx";
import { OutboxSection, type OutboxAction } from "./outbox.tsx";
import {
  conversationAiReason,
  messageToHand,
  ReadingPane,
  type BodyState,
  type ReadingSlice3h,
  type ReadingTranslation,
} from "./reading-pane.tsx";
import {
  SelectionBar,
  SelectionPanel,
  selectionActions,
  toggleSelection,
  type BarAction,
  type SelectionGroup,
} from "./selection-bar.tsx";
import { ShortcutSheet } from "./shortcut-sheet.tsx";
import { extendSelection, successorRow } from "./successor.ts";
import { SmtpDialog, type SmtpResult, type SmtpSettingsInput } from "./smtp-dialog.tsx";
import {
  createDestructiveGuard,
  useShortcuts,
  type DestructiveGuard,
  type GoTarget,
  type ShortcutCommand,
} from "./shortcuts.ts";
import {
  filterActive,
  FilteredEmpty,
  formatListDate,
  HistoryStrip,
  QuickFilters,
  SearchResultList,
  ThreadList,
  type HistoryState,
  type ListFilter,
} from "./thread-list.tsx";
import { SearchHelpButton, SearchNotes } from "./search-help.tsx";
import { ServerSearchStrip, type ServerJobView } from "./server-search-strip.tsx";
import { SAVED_SEARCH_GONE_TEXT } from "./saved-searches.tsx";
import { SenderCardDialog } from "./sender-card.tsx";

export { ALL_ACCOUNTS };

export interface ThreadListState {
  threads: ThreadSummary[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** Slice 3h: the folder is not grouped by conversation: one row per message (messages_list). */
  messages?: MessageSummary[];
}

export interface SearchState {
  /** The query the hits answer; empty when no search is active. */
  query: string;
  hits: MessageSummary[];
  loading: boolean;
  error: string | null;
  /** Slice 3h: why words of the query stayed text. */
  notes?: SearchNote[];
  /** Slice 3h: hits inside attachments (the owner's search with attachment text on). */
  attachmentMatches?: AttachmentMatch[];
  /** Slice 3h: the next page's cursor. */
  nextCursor?: string | null;
  loadingMore?: boolean;
}

/** Slice 3h: the page's server search. */
export interface ServerSearchState {
  /** The query it ran for; the strip shows only while that query is the search. */
  query: string;
  job: ServerJobView | null;
  localOnly: readonly SearchField[];
  /** Hits it brought into Mail. */
  ids: ReadonlySet<string>;
  error: string | null;
}

/** Search, older mail, saved searches, labels, drag and Files (slice 3h). */
export interface MailSlice3hPorts {
  /** This page load's drag id (drag-move.ts). */
  pageId: string;
  /** Files; the sender card opens it filtered by the sender. */
  onOpenFiles: (filter?: { sender: string }) => void;
  /** Save search: the page's dialog, with the query. */
  onSaveSearch: (query: string) => void;
  server: ServerSearchState | null;
  onServerSearch: (query: string) => void;
  onServerCancel: () => void;
  onServerMore: () => void;
  onSearchMore: () => void;
  /** An open saved search: its header with Edit, or the deleted note. */
  savedSearch: { name: string; query: string; onEdit: () => void } | "missing" | null;
  /** Older mail of the folder viewed; null for a role view. */
  history: HistoryState | null;
  historyStepDays: number;
  onLoadHistory: () => void;
  onStopHistory: () => void;
  /**
   * A drag of these conversations started (their accounts), or ended (null).
   * `advance` (slice 3i): opens the next conversation when the open one is
   * dragged to a folder and moved; null when nothing should open.
   */
  onDragAccounts: (accountIds: string[] | null, advance?: (() => void) | null) => void;
  /** Labels... (l) for conversations: Gmail accounts only. */
  onLabels: (threadIds: string[]) => void;
  /** Whether an account is Gmail (labels apply). */
  gmail: (accountId: string) => boolean;
  /** Reading (Task 11): viewer, quotes, plain text, dark mail, sender card, related mail and print. */
  reading?: Omit<ReadingSlice3h, "quotesAll" | "onExpandAll" | "onCollapseAll" | "onSender"> & {
    loadSenderCard: (address: string, accountId: string | null) => Promise<SenderCard>;
  };
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

/** Inbox triage on the page (slice 3e): unsubscribe, snooze and block. */
export interface MailInboxPorts {
  /** unsubscribe_info of a message of the open conversation (the newest), once loaded. */
  unsubscribe: { messageId: string; info: UnsubscribeInfoView } | null;
  /** Unsubscribe in the pane: the page opens its confirmation. */
  onUnsubscribe: (message: MessageHeader) => void;
  onArchiveList: (message: MessageHeader) => void;
  /**
   * Snooze the conversations' Inbox mail until `until` (UTC ISO). `then`
   * (slice 3i): run instead of closing when the open conversation went.
   */
  onSnooze: (threadIds: string[], until: string, then?: (() => void) | null) => void;
  onReturnNow: (threadId: string) => void;
  loadBlockCheck: (messageId: string) => Promise<BlockCheck>;
  onBlock: (messageId: string, choice: BlockChoice) => void;
}

/** The AI features and reply reminders on the page (slice 3f). */
export interface MailAiPorts {
  jobs: AiJobPorts;
  /** Why every AI button is off (Makosh AI is missing), or null. */
  disabledReason: string | null;
  keepTasks: (jobId: string, picks: TaskPick[]) => Promise<number>;
  /** Opens a conversation by its link (a cited message of another conversation). */
  onOpenConversation: (accountId: string, threadId: string) => void;
  /** mailCategories is on: chips, filters and the page actions show. */
  categoriesOn: boolean;
  onCategorySet: (messageIds: string[], category: Category | null) => void;
  onCategoryAccept: (messageIds: string[]) => void;
  onCategoryRule: (messageId: string, category: Category) => void;
  /** Suggest categories for the conversations of the list page. */
  onSuggestCategories: (threadIds: string[]) => void;
  /** Accept all on this page. */
  onAcceptPage: (threadIds: string[]) => void;
  /** replyReminderDays. */
  reminderDays: number;
  /** Due reply reminders: the Waiting for a reply strip in Inbox views. */
  reminders: readonly ReminderView[];
  onRemind: (messageId: string, days: number) => void;
  onReminderSnooze: (reminder: ReminderView, days: number) => void;
  onReminderDismiss: (reminder: ReminderView) => void;
}

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
  /** A link the owner opened, with its visible text when it came from a message body (slice 3i). */
  onOpenLink: (url: string, text?: string | null) => void;
  onHandToAgent: (message: MessageHeader) => void;
  /** Checked conversations of the list. */
  selection: ReadonlySet<string>;
  onSelectionChange: (next: ReadonlySet<string>) => void;
  /**
   * An action on conversations' messages in the view; `destination` goes with
   * move. `then` (slice 3i, removing actions on the open conversation with no
   * selection): run where the open conversation would close, only while it is
   * still the one acted on; null means nothing is left to open.
   */
  onThreadsAction: (
    threadIds: string[],
    action: MessageAction,
    destination?: string,
    then?: (() => void) | null,
  ) => void;
  /** An action is in flight; the buttons wait. */
  actionPending: boolean;
  /** The row star: flag the newest message in the view, or unflag the flagged ones. */
  onToggleThreadFlag: (threadId: string) => void;
  onToggleMessageFlag: (message: MessageHeader) => void;
  details: DetailsState | null;
  onOpenDetails: (message: MessageHeader) => void;
  onCloseDetails: () => void;
  /** Slice 3i: Details' Check again (sender_check_refresh with force); absent: not offered. */
  onCheckSender?: (messageId: string) => Promise<void>;
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
  /** Sending identities of every account and the templates (slice 3d), for the composer. */
  identities?: readonly IdentityView[];
  templates?: readonly TemplateView[];
  onManageTemplates?: () => void;
  /** `z`: undo the page's last action (slice 3d). */
  onUndo?: () => void;
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
  /** The quick filters of the list shown (slice 3e); absent: no toggles. */
  listFilter?: ListFilter;
  onListFilter?: (next: ListFilter) => void;
  /** Unsubscribe, snooze and block (slice 3e); absent: none of them. */
  inbox?: MailInboxPorts;
  /** Summaries, Ask, tasks, categories and reply reminders (slice 3f); absent: none of them. */
  ai?: MailAiPorts;
  /** The Today or Tasks page (slice 3f), shown instead of the list and the conversation. */
  page?: ReactNode;
  /** Slice 3g: the BB integration; absent: none of it. */
  bb?: MailBbPorts;
  /** Slice 3h: search, older mail, saved searches, labels, drag and Files; absent: none of it. */
  slice3h?: MailSlice3hPorts;
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
  if (props.page !== undefined) {
    return (
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border w-full max-w-2xl px-4 pb-6 pt-3 md:px-5 md:pt-4">{props.page}</div>
      </div>
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
function goView(props: MailPageProps, model: ViewModel, target: Exclude<GoTarget, "all" | "dev" | "files">): MailView | null {
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
  /** Slice 3i: a run of Shift+Down/Up: the selection when it started and the row it started on. */
  const shiftRun = useRef<{ base: ReadonlySet<string>; anchor: string } | null>(null);
  /** Slice 3i: a held arrow moved the cursor; its release opens the row there. */
  const heldArrow = useRef(false);
  /** Slice 3i: where the cursor goes once a removing action on a selection took its rows. */
  const afterSelection = useRef<{ target: string | null; removed: string[] } | null>(null);
  const conversationRef = useRef<HTMLElement | null>(null);
  const guardRef = useRef<DestructiveGuard | null>(null);
  guardRef.current ??= createDestructiveGuard();
  const destructiveGuard = guardRef.current;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [moveTargets, setMoveTargets] = useState<string[] | null>(null);
  const [snoozeTargets, setSnoozeTargets] = useState<string[] | null>(null);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  /** Slice 3f: the summary open on a conversation, the tasks request, Ask, a cited message, Remind me. */
  const [summaryFor, setSummaryFor] = useState<{ threadId: string; serial: number } | null>(null);
  const [tasksFor, setTasksFor] = useState<{ kind: "tasks"; threadId: string; folder?: string } | null>(null);
  const [askMode, setAskMode] = useState(false);
  const [asked, setAsked] = useState<{ question: string; serial: number } | null>(null);
  const [highlight, setHighlight] = useState<{ messageId: string; serial: number } | null>(null);
  const [remindMessage, setRemindMessage] = useState<string | null>(null);
  /** Slice 3h: the message opened from a folder that is not grouped; it shows alone. */
  const [singleMessage, setSingleMessage] = useState<string | null>(null);
  /** Slice 3h: the sender card open, from a message of the conversation. */
  const [senderFor, setSenderFor] = useState<{ message: MessageHeader; card: SenderCard | null; error: string | null } | null>(null);
  /** Slice 3h: Expand all / Collapse all of the open conversation (quotes follow). */
  const [quotesAll, setQuotesAll] = useState<{ threadId: string; shown: boolean } | null>(null);
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

  /** Slice 3h: a folder that is not grouped lists messages, as search does. */
  const messageRows = searching ? search.hits : (list.messages ?? null);
  const rowIds = messageRows !== null ? messageRows.map((h) => h.id) : list.threads.map((t) => t.id);
  const rowKey = rowIds.join("\n");

  // An action took the cursor row off the list: the next row (else the previous) takes the cursor.
  // After a removing action on a selection (slice 3i), the row after the last removed one does.
  const shownRows = useRef<string[]>(rowIds);
  useEffect(() => {
    const before = shownRows.current;
    shownRows.current = rowIds;
    // Consumed by the first change of the rows: a failed action leaves nothing behind.
    const pending = afterSelection.current;
    afterSelection.current = null;
    if (pending !== null && pending.removed.some((id) => !rowIds.includes(id))) {
      const target = pending.target !== null && rowIds.includes(pending.target) ? pending.target : null;
      if (target !== null) {
        setFocusedId(target);
        if (focusLost() && !focusRowElement(target)) focusRoot();
        return;
      }
    }
    if (focusedId === null || rowIds.includes(focusedId)) return;
    const next = successorRow(before, (id) => !rowIds.includes(id), focusedId);
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
    if (messageRows === null && focusedId !== null && rowIds.includes(focusedId)) return [focusedId];
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
    const removing = REMOVING_ACTIONS.has(action);
    if (removing) destructiveGuard.ran();
    const then = removing ? advanceFor(ids) : undefined;
    if (then !== undefined) props.onThreadsAction(ids, action, destination, then);
    else if (destination === undefined) props.onThreadsAction(ids, action);
    else props.onThreadsAction(ids, action, destination);
  };
  /** Whether a row belongs to one of the conversations `ids` (search hits and message rows by their conversation). */
  const rowIn = (ids: readonly string[]) => {
    const set = new Set(ids);
    return (rowId: string) =>
      messageRows !== null ? set.has(messageRows.find((h) => h.id === rowId)?.threadId ?? "") : set.has(rowId);
  };
  /**
   * Slice 3i (B5, B6): what comes after a removing action (or snooze) on
   * `ids`. With a selection, nothing opens: the cursor goes to the row after
   * the last removed one once the rows go (undefined is returned). On the
   * open conversation, the next row opens (`then`), or nothing is left (null).
   * Otherwise undefined: the app closes as before. The rows are the ones shown now.
   */
  const advanceFor = (ids: readonly string[]): (() => void) | null | undefined => {
    const isRemoved = rowIn(ids);
    if (selecting) {
      const removed = rowIds.filter(isRemoved);
      const last = removed.at(-1);
      afterSelection.current = last === undefined ? null : { target: successorRow(rowIds, isRemoved, last), removed };
      return undefined;
    }
    const open = reading.threadId;
    if (open === null || !ids.includes(open)) return undefined;
    const current =
      focusedId !== null && rowIds.includes(focusedId) && isRemoved(focusedId)
        ? focusedId
        : (rowIds.find((id) => rowIn([open])(id)) ?? null);
    if (current === null) return undefined;
    const next = successorRow(rowIds, isRemoved, current);
    if (next === null) return null;
    return () => {
      setFocusedId(next);
      openRow(next);
    };
  };

  const openRow = (id: string) => {
    if (messageRows !== null) {
      const hit = messageRows.find((h) => h.id === id);
      if (hit !== undefined) {
        setSingleMessage(!searching ? hit.id : null);
        props.onSelectThread(hit.threadId, hit.id, hit.accountId);
      }
      return;
    }
    setSingleMessage(null);
    const thread = list.threads.find((t) => t.id === id);
    if (thread !== undefined) props.onSelectThread(thread.id, null, thread.accountId);
  };
  const focusRow = (id: string) => {
    setFocusedId(id);
    focusRowElement(id);
  };
  /**
   * Whether moving the cursor opens the row: j/k only while a conversation is
   * open; Down/Up (slice 3i) also with nothing open in two columns. Behind the
   * selection panel nothing opens (it would be marked read unseen).
   */
  const moveOpens = (arrow: boolean) => !selecting && (threadOpen || (arrow && wide));
  /**
   * A held key (`repeat`) only moves the cursor: passing a conversation never
   * opens it. A held arrow opens the row it stopped on when released (onKeyUp).
   */
  const step = (delta: 1 | -1, repeat: boolean, arrow = false) => {
    if (rowIds.length === 0) return;
    const current = focusedId === null ? -1 : rowIds.indexOf(focusedId);
    const nextIndex = current < 0 ? 0 : Math.min(Math.max(current + delta, 0), rowIds.length - 1);
    const next = rowIds[nextIndex]!;
    focusRow(next);
    heldArrow.current = repeat && arrow && moveOpens(true);
    if (!repeat && moveOpens(arrow)) openRow(next);
  };
  /** Releasing a held arrow opens the row under the cursor (same rule as a press). */
  const onKeyUp = (event: { code: string }) => {
    if (event.code !== "ArrowDown" && event.code !== "ArrowUp") return;
    if (!heldArrow.current) return;
    heldArrow.current = false;
    if (focusedId === null || !rowIds.includes(focusedId) || !moveOpens(true)) return;
    openRow(focusedId);
  };
  /** Shift+Down/Up (slice 3i): the cursor moves and the selection grows from where the run started. */
  const extend = (delta: 1 | -1) => {
    // Grouped lists only, never in one column with a conversation open (as x).
    if (messageRows !== null || (threadOpen && !wide) || rowIds.length === 0) return;
    const current = focusedId === null ? -1 : rowIds.indexOf(focusedId);
    let run = shiftRun.current;
    if (run === null || !rowIds.includes(run.anchor) || (selection.size > 0 && !selection.has(run.anchor))) {
      const start = current < 0 ? rowIds[0]! : focusedId!;
      run = { base: new Set(selection), anchor: start };
      shiftRun.current = run;
    }
    const to = current < 0 ? run.anchor : rowIds[Math.min(Math.max(current + delta, 0), rowIds.length - 1)]!;
    focusRow(to);
    anchor.current = to;
    props.onSelectionChange(extendSelection({ order: rowIds, base: run.base, anchor: run.anchor, to }));
  };
  /** Down/Up on a message header or the stack (slice 3i): focus moves to the next or previous one. */
  const focusMessage = (delta: 1 | -1) => {
    const container = conversationRef.current;
    if (container === null) return;
    const headers = Array.from(
      container.querySelectorAll<HTMLElement>("[data-mail-message-toggle], [data-mail-stack]"),
    );
    const active = document.activeElement;
    const at = headers.findIndex((element) => element === active || element.contains(active));
    if (at < 0) return;
    headers[at + delta]?.focus();
  };
  /** Shift+Command+U (slice 3i): mark read when anything targeted is unread, else unread. */
  const toggleRead = () => {
    const ids = targets();
    if (ids.length === 0) return;
    // The open conversation was marked read when it opened.
    const anyUnread = ids.some(
      (id) => id !== reading.threadId && (list.threads.find((t) => t.id === id)?.unreadCount ?? 0) > 0,
    );
    runIfAllowed(ids, anyUnread ? "mark_read" : "mark_unread");
  };
  /**
   * A row click (or o/Enter on the cursor row). With a selection: in one
   * column it toggles the row's checkbox (Gmail on phones); in two columns it
   * ends the selection and opens the row, as Apple Mail does.
   */
  const activateRow = (id: string) => {
    shiftRun.current = null;
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
    shiftRun.current = null;
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
  /** Snooze (b, the toolbar, the bar): Inbox mail only. */
  const openSnooze = (ids: string[]) => {
    if (ids.length === 0 || props.inbox === undefined || model.use !== "inbox" || props.actionPending) return;
    rememberOpener();
    setSnoozeTargets(ids);
  };
  const openMove = (ids: string[]) => {
    if (ids.length === 0) return;
    destructiveGuard.ran();
    rememberOpener();
    setMoveTargets(ids);
  };

  // ---- Slice 3f: the AI features of the open conversation ----

  const ai = props.ai;
  const openDetail = reading.detail;
  /** The folder the server reads the open conversation in. */
  const aiFolder = openDetail === null ? undefined : model.pathsOf(openDetail.thread.accountId)[0];
  const aiReason = ai === undefined || openDetail === null ? null : conversationAiReason(openDetail.messages, ai.disabledReason);
  const aiReady = ai !== undefined && openDetail !== null && threadOpen && !selecting && aiReason === null;
  const summarize = () => {
    if (!aiReady || openDetail === null) return;
    setSummaryFor((prev) => ({ threadId: openDetail.thread.id, serial: (prev?.serial ?? 0) + 1 }));
  };
  const findTasks = () => {
    if (!aiReady || openDetail === null) return;
    rememberOpener();
    setTasksFor({ kind: "tasks", threadId: openDetail.thread.id, ...(aiFolder !== undefined ? { folder: aiFolder } : {}) });
  };
  /** A citation chip: a message of the open conversation comes into view; another conversation opens. */
  const cite = (citation: AiCitation) => {
    if (citation.threadId === reading.threadId) {
      if (!reading.expandedIds.has(citation.messageId)) props.onToggleMessage(citation.messageId);
      setHighlight((prev) => ({ messageId: citation.messageId, serial: (prev?.serial ?? 0) + 1 }));
      return;
    }
    ai?.onOpenConversation(citation.accountId, citation.threadId);
  };
  // The mark on a cited message fades after a moment.
  useEffect(() => {
    if (highlight === null) return;
    const timer = setTimeout(() => setHighlight(null), 2_000);
    return () => clearTimeout(timer);
  }, [highlight?.serial]);
  const bbUi = useBbDialogs(props.bb, reading.detail);
  const bbMessage = () => {
    if (!threadOpen || selecting || reading.detail === null) return null;
    const message = messageToHand(reading.detail.messages, reading.expandedIds);
    return message !== null && !isDraft(message) ? message : null;
  };
  /** Slice 3h: every message of the open conversation opens (quotes shown), or all but the newest close. */
  const expandAll = (expand: boolean) => {
    const detail = reading.detail;
    if (detail === null || reading.threadId === null) return;
    const messages = detail.messages;
    for (const [index, message] of messages.entries()) {
      const open = reading.expandedIds.has(message.id);
      const wanted = expand || index === messages.length - 1;
      if (open !== wanted) props.onToggleMessage(message.id);
    }
    setQuotesAll({ threadId: reading.threadId, shown: expand });
  };
  const openSender = (message: MessageHeader) => {
    const port = props.slice3h?.reading;
    if (port === undefined) return;
    rememberOpener();
    setSenderFor({ message, card: null, error: null });
    port.loadSenderCard(message.from.address, message.accountId).then(
      (card) => setSenderFor((prev) => (prev?.message === message ? { ...prev, card } : prev)),
      (error: unknown) =>
        setSenderFor((prev) => (prev?.message === message ? { ...prev, error: error instanceof Error ? error.message : String(error) } : prev)),
    );
  };
  const reading3h: ReadingSlice3h | undefined =
    props.slice3h?.reading === undefined
      ? undefined
      : {
          ...props.slice3h.reading,
          onSender: openSender,
          quotesAll: quotesAll !== null && quotesAll.threadId === reading.threadId ? quotesAll.shown : null,
          onExpandAll: () => expandAll(true),
          onCollapseAll: () => expandAll(false),
        };
  const summaryShown = summaryFor !== null && summaryFor.threadId === reading.threadId && openDetail !== null && ai !== undefined;

  const onKeyDown = useShortcuts((command: ShortcutCommand, repeat: boolean) => {
    // A quick second tap after an action must not reach the cursor row.
    if (!destructiveGuard.admit(command)) return;
    // Any other key ends a run of Shift+Down/Up; a held arrow's run ends on any other key.
    if (command.kind !== "select_down" && command.kind !== "select_up") shiftRun.current = null;
    if (command.kind !== "next" && command.kind !== "previous") heldArrow.current = false;
    switch (command.kind) {
      case "next":
        return step(1, repeat, command.arrow === true);
      case "previous":
        return step(-1, repeat, command.arrow === true);
      case "select_down":
        return extend(1);
      case "select_up":
        return extend(-1);
      case "message_next":
        return focusMessage(1);
      case "message_previous":
        return focusMessage(-1);
      case "toggle_read":
        return toggleRead();
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
        if (!(threadOpen && !wide) && messageRows === null && focusedId !== null && rowIds.includes(focusedId)) toggleChecked(focusedId, false);
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
      case "undo":
        props.onUndo?.();
        return;
      case "snooze":
        return openSnooze(targets());
      case "summarize":
        return summarize();
      case "find_tasks":
        return findTasks();
      case "new_bb_thread": {
        const message = bbMessage();
        if (message !== null) bbUi.newThreadFor(message);
        return;
      }
      case "make_task": {
        const message = bbMessage();
        if (message !== null) bbUi.makeTaskFor(message);
        return;
      }
      case "expand_all": {
        if (!threadOpen || selecting || reading.detail === null || reading3h === undefined) return;
        const allOpen = reading.detail.messages.every((m) => reading.expandedIds.has(m.id));
        expandAll(!allOpen || reading3h.quotesAll !== true);
        return;
      }
      case "print": {
        if (!threadOpen || selecting || reading.detail === null || reading3h === undefined) return;
        reading3h.onPrint(reading.detail.messages);
        return;
      }
      case "labels": {
        const ids = targets();
        const s3 = props.slice3h;
        if (s3 === undefined || ids.length === 0) return;
        const accounts = new Set(ids.map(accountOfThread));
        if ([...accounts].every((id) => id !== null && s3.gmail(id))) s3.onLabels(ids);
        return;
      }
      case "sheet":
        rememberOpener();
        setSheetOpen(true);
        return;
      case "go": {
        if (command.target === "dev") {
          props.bb?.onOpenDev?.();
          return;
        }
        if (command.target === "files") {
          props.slice3h?.onOpenFiles();
          return;
        }
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
    else if (action === "snooze") openSnooze([...selection]);
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
        {...(props.identities !== undefined ? { identities: props.identities } : {})}
        {...(props.templates !== undefined ? { templates: props.templates } : {})}
        {...(props.onManageTemplates !== undefined ? { onManageTemplates: props.onManageTemplates } : {})}
        {...(props.ai !== undefined
          ? { improve: { jobs: props.ai.jobs, disabledReason: props.ai.disabledReason }, reminderDays: props.ai.reminderDays }
          : {})}
        {...(props.bb !== undefined
          ? { bbFiles: { call: props.bb.call, projectId: props.bb.context.projectId, threadId: props.bb.context.threadId } }
          : {})}
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
      onKeyUp={onKeyUp}
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
        askMode={ai !== undefined && askMode}
        onAskMode={ai === undefined ? undefined : (on) => {
          setAskMode(on);
          if (!on) setAsked(null);
        }}
        onAsk={(question) => setAsked((prev) => (question === "" ? null : { question, serial: (prev?.serial ?? 0) + 1 }))}
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
          {!searching && props.listFilter !== undefined && props.onListFilter !== undefined ? (
            <QuickFilters
              filter={props.listFilter}
              onChange={props.onListFilter}
              categories={ai?.categoriesOn === true}
              dev={props.bb?.devFilter === true}
            />
          ) : null}
          {!searching && ai !== undefined && ai.categoriesOn && list.threads.length > 0 ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground"
                disabled={ai.disabledReason !== null}
                onClick={() => ai.onSuggestCategories(list.threads.map((t) => t.id))}
              >
                Suggest categories
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground"
                disabled={!list.threads.some((t) => t.category === null && t.categorySuggestion !== null)}
                onClick={() =>
                  ai.onAcceptPage(list.threads.filter((t) => t.category === null && t.categorySuggestion !== null).map((t) => t.id))
                }
              >
                Accept all on this page
              </Button>
            </div>
          ) : null}
          {!searching && ai !== undefined && model.use === "inbox" ? (
            <ReminderStrip
              reminders={ai.reminders.filter((r) => props.unified || r.accountId === props.account?.id)}
              defaultDays={ai.reminderDays}
              onOpen={(reminder) => {
                if (reminder.threadId !== null) ai.onOpenConversation(reminder.accountId, reminder.threadId);
              }}
              onSnooze={ai.onReminderSnooze}
              onDismiss={ai.onReminderDismiss}
            />
          ) : null}
          {!searching && props.bb?.ruleRuns !== undefined && model.use === "inbox" ? (
            <RuleStrip
              runs={props.bb.ruleRuns}
              onReview={bbUi.reviewRun}
              onDismiss={(run) => props.bb?.onDismissRun?.(run)}
              onPauseAll={() => props.bb?.onPauseRules?.()}
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
          {ai !== undefined && askMode && asked !== null ? (
            <AskPanel
              key={asked.serial}
              ports={ai.jobs}
              question={asked.question}
              {...(!props.unified && props.account !== null ? { accountId: props.account.id } : {})}
              onOpen={(citation) => ai.onOpenConversation(citation.accountId, citation.threadId)}
              onClose={() => setAsked(null)}
            />
          ) : null}
          {!searching && props.slice3h?.savedSearch === "missing" ? (
            <p role="status" className="border-b border-border px-3 py-2 text-sm text-muted-foreground">
              {SAVED_SEARCH_GONE_TEXT}
            </p>
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
            dragAdvance={(ids) => {
              // A drag of a selection, or of other rows than the open one: nothing opens.
              if (selecting || reading.threadId === null || !ids.includes(reading.threadId)) return null;
              return advanceFor(ids) ?? null;
            }}
          />
        </section>
        <section
          ref={conversationRef}
          aria-label="Conversation"
          // Slice 3i: a click on message text focuses the conversation, where the arrows scroll.
          data-mail-reading=""
          tabIndex={-1}
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-y-auto outline-none @3xl:flex",
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
              onlyMessageId={list.messages !== undefined && !searching ? singleMessage : null}
              onShowConversation={() => setSingleMessage(null)}
              {...(reading3h !== undefined ? { reading3h } : {})}
              {...(props.slice3h !== undefined && openAccount !== null && props.slice3h.gmail(openAccount) && reading.threadId !== null
                ? { onLabels: () => props.slice3h?.onLabels([reading.threadId!]) }
                : {})}
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
              {...(bbUi.reading !== undefined ? { bb: bbUi.reading } : {})}
              ai={
                ai === undefined || openDetail === null
                  ? undefined
                  : {
                      disabledReason: ai.disabledReason,
                      onSummarize: summarize,
                      onFindTasks: findTasks,
                      summary: summaryShown ? (
                        <SummaryBlock
                          key={`${summaryFor.threadId}:${summaryFor.serial}`}
                          ports={ai.jobs}
                          threadId={summaryFor.threadId}
                          {...(aiFolder !== undefined ? { folder: aiFolder } : {})}
                          onCite={cite}
                          onClose={() => setSummaryFor(null)}
                        />
                      ) : null,
                      category: ai.categoriesOn
                        ? (() => {
                            const shown = messageToHand(openDetail.messages, reading.expandedIds);
                            if (shown === null || isDraft(shown)) return null;
                            const address = shown.from.address.trim();
                            // The list row carries the local suggestion threads_list adds; thread_get may not.
                            const row = list.threads.find((t) => t.id === openDetail.thread.id);
                            return (
                              <CategoryChip
                                category={row?.category ?? openDetail.thread.category}
                                suggestion={row?.categorySuggestion ?? openDetail.thread.categorySuggestion}
                                onAccept={() => ai.onCategoryAccept([shown.id])}
                                onChange={(category) => ai.onCategorySet([shown.id], category)}
                                onAlways={
                                  address === "" || model.use === "sent" ? null : (category) => ai.onCategoryRule(shown.id, category)
                                }
                              />
                            );
                          })()
                        : null,
                      ...(model.use === "sent"
                        ? {
                            onRemind: (message: MessageHeader) => {
                              rememberOpener();
                              setRemindMessage(message.id);
                            },
                          }
                        : {}),
                      highlight,
                    }
              }
              inbox={
                props.inbox === undefined
                  ? undefined
                  : {
                      unsubscribe: (() => {
                        const shown = reading.detail === null ? null : messageToHand(reading.detail.messages, reading.expandedIds);
                        const loaded = props.inbox.unsubscribe;
                        return loaded !== null && shown !== null && loaded.messageId === shown.id ? loaded.info : null;
                      })(),
                      onUnsubscribe: () => {
                        const shown = reading.detail === null ? null : messageToHand(reading.detail.messages, reading.expandedIds);
                        if (shown !== null) props.inbox?.onUnsubscribe(shown);
                      },
                      onArchiveList: () => {
                        const shown = reading.detail === null ? null : messageToHand(reading.detail.messages, reading.expandedIds);
                        if (shown !== null) props.inbox?.onArchiveList(shown);
                      },
                      onSnooze: () => openSnooze(reading.threadId !== null ? [reading.threadId] : []),
                      onBlock: (message) => {
                        rememberOpener();
                        setBlockMessage(message.id);
                      },
                      onReturnNow: () => {
                        if (reading.threadId !== null) props.inbox?.onReturnNow(reading.threadId);
                      },
                    }
              }
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
      {props.inbox !== undefined ? (
        <>
          <SnoozeMenu
            open={snoozeTargets !== null}
            count={snoozeTargets?.length ?? 1}
            onOpenChange={(open) => {
              if (!open) setSnoozeTargets(null);
            }}
            onPick={(until) => {
              const ids = snoozeTargets ?? [];
              setSnoozeTargets(null);
              destructiveGuard.ran();
              const then = advanceFor(ids);
              if (then !== undefined) props.inbox?.onSnooze(ids, until, then);
              else props.inbox?.onSnooze(ids, until);
            }}
            onCloseAutoFocus={restoreFocus}
            onAfterCloseAutoFocus={afterClose}
          />
          <BlockDialog
            messageId={blockMessage}
            load={props.inbox.loadBlockCheck}
            onBlock={(messageId, choice) => {
              setBlockMessage(null);
              props.inbox?.onBlock(messageId, choice);
            }}
            onCancel={() => setBlockMessage(null)}
            onCloseAutoFocus={restoreFocus}
            onAfterCloseAutoFocus={afterClose}
          />
        </>
      ) : null}
      {bbUi.dialogs}
      {ai !== undefined ? (
        <>
          <TasksDialog
            request={tasksFor}
            ports={ai.jobs}
            onKeep={ai.keepTasks}
            onCite={(citation) => {
              setTasksFor(null);
              cite(citation);
            }}
            onClose={() => setTasksFor(null)}
            onCloseAutoFocus={restoreFocus}
          />
          <RemindDialog
            open={remindMessage !== null}
            defaultDays={ai.reminderDays}
            onRemind={(days) => {
              const id = remindMessage;
              setRemindMessage(null);
              if (id !== null) ai.onRemind(id, days);
            }}
            onCancel={() => setRemindMessage(null)}
            onCloseAutoFocus={restoreFocus}
          />
        </>
      ) : null}
      <DetailsPanel
        details={props.details}
        onClose={props.onCloseDetails}
        onCopy={props.onCopy}
        onCloseAutoFocus={restoreFocus}
        onAfterCloseAutoFocus={afterClose}
        {...(props.onCheckSender !== undefined ? { onCheckAgain: props.onCheckSender } : {})}
      />
      <SmtpDialog
        account={status.accounts.find((a) => a.id === props.smtpAccountId) ?? null}
        onClose={props.onCloseSmtp}
        onTest={props.onTestSmtp}
        onSave={props.onSaveSmtp}
      />
      {props.slice3h?.reading !== undefined ? (
        <SenderCardDialog
          address={senderFor?.message.from.address ?? null}
          card={senderFor?.card ?? null}
          error={senderFor?.error ?? null}
          onClose={() => setSenderFor(null)}
          actions={{
            onSearch: (address) => {
              setSenderFor(null);
              props.onSearch(`from:${address}`);
            },
            onFiles: (address) => {
              setSenderFor(null);
              props.slice3h?.onOpenFiles({ sender: address });
            },
            onOpenConversation: (thread) => {
              setSenderFor(null);
              props.onSelectThread(thread.id, null, thread.accountId);
            },
            ...(senderFor !== null
              ? {
                  onAlwaysShowImages: () => {
                    const message = senderFor.message;
                    setSenderFor(null);
                    props.onAlwaysShowImages(message);
                  },
                }
              : {}),
            ...(senderFor !== null && props.inbox !== undefined
              ? {
                  onBlock: () => {
                    const message = senderFor.message;
                    setSenderFor(null);
                    setBlockMessage(message.id);
                  },
                }
              : {}),
          }}
        />
      ) : null}
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
    /** Slice 3i: what opens if the dragged conversations are moved (see advanceFor). */
    dragAdvance: (ids: string[]) => (() => void) | null;
  },
) {
  const { status, list, search, reading } = props;
  const emailOf = (accountId: string) => status.accounts.find((a) => a.id === accountId)?.email ?? null;

  const s3 = props.slice3h;
  if (search.query !== "") {
    const server = s3?.server ?? null;
    const serverHere = server !== null && server.query === search.query ? server : null;
    let results: ReactNode;
    if (search.error !== null) {
      results = <ListMessage role="alert" text={search.error} />;
    } else if (search.loading && search.hits.length === 0) {
      results = <ListMessage text="Searching\u2026" />;
    } else if (search.hits.length === 0) {
      results = <NoSearchResults query={search.query} />;
    } else {
      results = (
        <SearchResultList
          hits={search.hits}
          selectedThreadId={reading.threadId}
          marker={props.marker}
          onSelect={(hit) => props.onOpenRow(hit.id)}
          focusedId={props.focusedId}
          {...(serverHere !== null ? { serverIds: serverHere.ids } : {})}
          matches={search.attachmentMatches ?? []}
          more={
            s3 !== undefined && (search.nextCursor ?? null) !== null
              ? { loading: search.loadingMore === true, onMore: s3.onSearchMore }
              : null
          }
        />
      );
    }
    if (s3 === undefined) return results;
    const saved = s3.savedSearch;
    return (
      <>
        {saved === "missing" ? (
          <p role="status" className="border-b border-border px-3 py-2 text-sm text-muted-foreground">
            {SAVED_SEARCH_GONE_TEXT}
          </p>
        ) : saved !== null ? (
          <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-foreground">{saved.name}</span>
              {` \u00b7 ${saved.query}`}
            </span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={saved.onEdit}>
              Edit
            </Button>
          </div>
        ) : null}
        <SearchNotes notes={search.notes ?? []} />
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1 text-xs text-muted-foreground">
          <span className="mr-1">
            {search.loading ? "Searching\u2026" : `${search.hits.length}${(search.nextCursor ?? null) !== null ? "+" : ""} in Mail`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={serverHere?.job?.state === "running"}
            onClick={() => s3.onServerSearch(search.query)}
          >
            Search on the server
          </Button>
          {saved === null ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => s3.onSaveSearch(search.query)}>
              Save search
            </Button>
          ) : null}
        </div>
        {serverHere !== null && serverHere.error !== null ? (
          <p role="alert" className="border-b border-border px-3 py-1 text-xs text-destructive">
            {serverHere.error}
          </p>
        ) : null}
        {serverHere !== null && serverHere.job !== null ? (
          <ServerSearchStrip
            job={serverHere.job}
            query={search.query}
            localOnly={serverHere.localOnly}
            accountName={(id) => {
              const account = status.accounts.find((a) => a.id === id);
              return account === undefined ? "Account" : accountLabel(account);
            }}
            shownFromServer={search.hits.filter((h) => serverHere.ids.has(h.id)).length}
            onCancel={s3.onServerCancel}
            onMore={s3.onServerMore}
          />
        ) : null}
        {results}
      </>
    );
  }

  const history =
    s3 !== undefined && s3.history !== null ? (
      <HistoryStrip state={s3.history} stepDays={s3.historyStepDays} onLoad={s3.onLoadHistory} onStop={s3.onStopHistory} />
    ) : null;
  if (list.messages !== undefined) {
    if (list.error !== null && list.messages.length === 0) return <ListMessage role="alert" text={list.error} />;
    if (list.loading && list.messages.length === 0) return <ListMessage text="Loading mail\u2026" />;
    if (list.messages.length === 0) {
      return (
        <>
          <EmptyFolder name={props.emptyName} />
          {history}
        </>
      );
    }
    return (
      <>
        <SearchResultList
          label="Messages"
          hits={list.messages}
          selectedThreadId={reading.threadId}
          marker={props.marker}
          onSelect={(hit) => props.onOpenRow(hit.id)}
          focusedId={props.focusedId}
          more={list.nextCursor !== null ? { loading: list.loadingMore, onMore: props.onLoadMore } : null}
        />
        {list.nextCursor === null ? history : null}
      </>
    );
  }

  if (list.error !== null && list.threads.length === 0) {
    return <ListMessage role="alert" text={list.error} />;
  }
  if (list.loading && list.threads.length === 0) return <ListMessage text="Loading mail…" />;
  if (list.threads.length === 0) {
    const filter = props.listFilter;
    if (filter !== undefined && filterActive(filter)) {
      return <FilteredEmpty filter={filter} onClear={() => props.onListFilter?.({})} />;
    }
    const shown = props.unified ? status.accounts : props.account !== null ? [props.account] : [];
    // The banner above already shows lastError; the folder is simply empty.
    const clean = shown.every((a) => a.lastError === null);
    if (clean && (props.syncing || shown.some((a) => a.lastSyncAt === null))) {
      return <SyncingState />;
    }
    return (
      <>
        <EmptyFolder name={props.emptyName} />
        {history}
      </>
    );
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
      categories={props.ai?.categoriesOn === true}
      footer={history}
      {...(s3 !== undefined
        ? {
            drag: {
              pageId: s3.pageId,
              onStart: (ids: string[]) =>
                s3.onDragAccounts(
                  [
                    ...new Set(ids.map((id) => list.threads.find((t) => t.id === id)?.accountId).filter((a): a is string => a !== undefined)),
                  ],
                  props.dragAdvance(ids),
                ),
              onEnd: () => s3.onDragAccounts(null),
            },
          }
        : {})}
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
    /** Slice 3f: the box asks a question instead of searching. */
    askMode?: boolean;
    onAskMode?: (on: boolean) => void;
    onAsk?: (question: string) => void;
  },
) {
  const [draft, setDraft] = useState(props.search.query);
  const asking = props.askMode === true;

  // The page may end a search (a folder was chosen); the box follows.
  useEffect(() => {
    setDraft(props.search.query);
  }, [props.search.query]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (asking) props.onAsk?.(draft.trim().slice(0, ASK_QUESTION_MAX));
    else props.onSearch(draft.trim());
  }

  function clear() {
    setDraft("");
    if (asking) props.onAsk?.("");
    else props.onSearch("");
  }

  function switchMode(ask: boolean) {
    if (ask === asking) return;
    setDraft("");
    if (props.search.query !== "") props.onSearch("");
    props.onAskMode?.(ask);
  }

  const shown = props.unified ? props.status.accounts : props.account !== null ? [props.account] : [];
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      {props.onAskMode !== undefined ? (
        <div role="group" aria-label="Search or ask" className="flex shrink-0 items-center rounded-md border border-border p-0.5">
          <Button
            type="button"
            variant={asking ? "ghost" : "secondary"}
            size="sm"
            className="h-6 px-2 text-xs"
            aria-pressed={!asking}
            onClick={() => switchMode(false)}
          >
            Search
          </Button>
          <Button
            type="button"
            variant={asking ? "secondary" : "ghost"}
            size="sm"
            className="h-6 px-2 text-xs"
            aria-pressed={asking}
            onClick={() => switchMode(true)}
          >
            Ask
          </Button>
        </div>
      ) : null}
      <form role="search" onSubmit={submit} className="flex min-w-40 flex-1 items-center gap-1">
        <Input
          ref={props.searchRef}
          type="search"
          aria-label={asking ? "Ask about your mail" : "Search mail"}
          placeholder={asking ? "Ask about your mail (AI)" : "Search mail \u2014 from:, has:attachment, -in:trash"}
          value={draft}
          maxLength={asking ? ASK_QUESTION_MAX : 500}
          onChange={(event) => setDraft(event.target.value)}
          className="h-8"
        />
        {props.search.query !== "" || (asking && draft !== "") ? (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        ) : null}
        {props.slice3h !== undefined && !asking ? <SearchHelpButton /> : null}
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
