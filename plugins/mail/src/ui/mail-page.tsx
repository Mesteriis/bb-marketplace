// The Mail page: header (account, search, sync), the folder rail, the
// conversation list and the reading pane. Data and actions arrive through props; nothing here knows the
// host, so the same page renders in BB and in any other shell.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  Account,
  Folder,
  MessageAction,
  MessageHeader,
  MessageSummary,
  NewAccountInput,
  StatusView,
  ThreadDetail,
  ThreadSummary,
} from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { AccountForm, type AccountFormInitial, type AccountFormProps } from "./account-form.tsx";
import {
  EmptyFolder,
  LoadingState,
  NoSearchResults,
  NothingSelected,
  SyncingState,
  VaultNotReady,
} from "./empty-states.tsx";
import { FolderList, FolderSelect } from "./folder-list.tsx";
import { ReadingPane, type BodyState } from "./reading-pane.tsx";
import { formatListDate, SearchResultList, ThreadList } from "./thread-list.tsx";

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

export interface MailPageProps {
  /** null while the first load is in flight. */
  status: StatusView | null;
  statusError: string | null;
  account: Account | null;
  onSelectAccount: (accountId: string) => void;
  /** The account's folders; null while they load. */
  folders: Folder[] | null;
  /** Why the folders could not be loaded; null when they could. */
  foldersError: string | null;
  /** Path of the folder the list shows. */
  folderPath: string;
  onSelectFolder: (path: string) => void;
  list: ThreadListState;
  onLoadMore: () => void;
  search: SearchState;
  onSearch: (query: string) => void;
  syncing: boolean;
  onSync: () => void;
  reading: ReadingState;
  onSelectThread: (threadId: string, messageId: string | null) => void;
  onCloseThread: () => void;
  onToggleMessage: (messageId: string) => void;
  onOpenLink: (url: string) => void;
  onHandToAgent: (message: MessageHeader) => void;
  onAction: (action: MessageAction) => void;
  actionPending: boolean;
  onShowImages: (messageId: string) => void;
  onAlwaysShowImages: (message: MessageHeader) => void;
  accountForm: AccountFormRequest;
  onOpenAccountForm: (request: { initial?: AccountFormInitial }) => void;
  onCloseAccountForm: () => void;
  onTestAccount: (input: NewAccountInput) => Promise<{ ok: boolean; reason: string | null }>;
  onSaveAccount: (input: NewAccountInput) => Promise<void>;
  ExternalLink: AccountFormProps["ExternalLink"];
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
  const { status, statusError, account, accountForm } = props;

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
  if (account === null || accountForm !== null) {
    const first = account === null;
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
  return <Mailbox {...props} account={account} status={status} />;
}

/** The folder's display name; the path itself when the folder is unknown. */
function nameOf(folders: Folder[] | null, path: string): string {
  return folders?.find((f) => f.path === path)?.name ?? (path === "INBOX" ? "Inbox" : path);
}

function Mailbox(props: MailPageProps & { account: Account; status: StatusView }) {
  const { account, reading, folders, folderPath } = props;
  const threadOpen = reading.threadId !== null;
  const folder = folders?.find((f) => f.path === folderPath) ?? null;
  const folderUse = folder?.specialUse ?? (folderPath === "INBOX" ? "inbox" : null);

  return (
    <div className="@container flex h-full min-h-0 flex-1 flex-col">
      <MailHeader {...props} />
      {account.lastError !== null ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1">{account.lastError}</span>
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
      ) : null}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Folders"
          className="hidden min-h-0 w-48 shrink-0 flex-col overflow-y-auto border-r border-border @4xl:flex @6xl:w-56"
        >
          <div className="px-1.5 pb-1 pt-2">
            <AccountChooser {...props} className="w-full max-w-none" />
          </div>
          <FolderList
            folders={folders ?? []}
            selectedPath={folderPath}
            onSelect={props.onSelectFolder}
            error={props.foldersError}
          />
        </nav>
        <section
          aria-label={nameOf(folders, folderPath)}
          className={cn(
            "min-h-0 w-full shrink-0 flex-col overflow-y-auto @3xl:flex @3xl:w-80 @3xl:border-r @3xl:border-border @6xl:w-96",
            threadOpen ? "hidden" : "flex",
          )}
        >
          <ListColumn {...props} />
        </section>
        <section
          aria-label="Conversation"
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @3xl:flex",
            threadOpen ? "flex" : "hidden",
          )}
        >
          {threadOpen ? (
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
              folderPath={folderPath}
              folderUse={folderUse}
              folderName={(path) => nameOf(folders, path)}
              onAction={props.onAction}
              actionPending={props.actionPending}
              remoteImageIds={reading.remoteImageIds}
              imageSenders={reading.imageSenders}
              onShowImages={props.onShowImages}
              onAlwaysShowImages={props.onAlwaysShowImages}
            />
          ) : (
            <NothingSelected />
          )}
        </section>
      </div>
    </div>
  );
}

function ListColumn(props: MailPageProps & { account: Account }) {
  const { account, list, search, reading } = props;

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
        onSelect={(threadId, messageId) => props.onSelectThread(threadId, messageId)}
      />
    );
  }

  if (list.error !== null && list.threads.length === 0) {
    return <ListMessage role="alert" text={list.error} />;
  }
  if (list.loading && list.threads.length === 0) return <ListMessage text="Loading mail…" />;
  if (list.threads.length === 0) {
    // The banner above already shows lastError; the folder is simply empty.
    if (account.lastError === null && (account.lastSyncAt === null || props.syncing)) {
      return <SyncingState />;
    }
    return <EmptyFolder name={nameOf(props.folders, props.folderPath)} />;
  }
  return (
    <ThreadList
      threads={list.threads}
      selectedThreadId={reading.threadId}
      ownAddress={account.email}
      onSelect={(threadId) => props.onSelectThread(threadId, null)}
      hasMore={list.nextCursor !== null}
      loadingMore={list.loadingMore}
      onLoadMore={props.onLoadMore}
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

/** The account select (several accounts) or the account's name. */
function AccountChooser(
  props: MailPageProps & { account: Account; status: StatusView; className?: string },
) {
  const { account, status } = props;
  if (status.accounts.length > 1) {
    return (
      <Select value={account.id} onValueChange={props.onSelectAccount}>
        <SelectTrigger aria-label="Account" className={cn("h-8 w-auto max-w-56", props.className)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {status.accounts.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.displayName ?? item.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <span
      className={cn("block max-w-56 truncate px-2 text-sm font-medium text-foreground", props.className)}
    >
      {account.displayName ?? account.email}
    </span>
  );
}

function MailHeader(props: MailPageProps & { account: Account; status: StatusView }) {
  const { account, syncing } = props;
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

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2 @4xl:hidden">
        <AccountChooser {...props} />
        <FolderSelect
          folders={props.folders ?? []}
          selectedPath={props.folderPath}
          onSelect={props.onSelectFolder}
        />
      </div>

      <form role="search" onSubmit={submit} className="flex min-w-40 flex-1 items-center gap-1">
        <Input
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

      <span className="text-xs text-muted-foreground">
        {syncing
          ? "Syncing…"
          : account.lastSyncAt !== null
            ? `Synced ${formatListDate(account.lastSyncAt)}`
            : "Not synced yet"}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sync now"
        disabled={syncing}
        onClick={props.onSync}
      >
        <Icon name="RotateCcw" aria-hidden />
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
