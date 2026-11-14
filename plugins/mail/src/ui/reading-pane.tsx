// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/components/email/MessageItem.tsx, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// The right column: one conversation, messages oldest first. Collapsed
// messages show sender, date and snippet; an expanded one shows its body.
// The toolbar moves the conversation's messages in the folder being viewed.
import type {
  MessageAction,
  MessageBody,
  MessageHeader,
  SpecialUse,
  ThreadDetail,
} from "../core/index.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { LoadingState } from "./empty-states.tsx";
import { MessageFrame } from "./message-frame.tsx";
import { addressLabel, formatFullDate, subjectOrPlaceholder } from "./thread-list.tsx";

export type BodyState =
  | { status: "loading" }
  | { status: "ready"; body: MessageBody }
  | { status: "error"; error: string };

export interface ReadingPaneProps {
  detail: ThreadDetail | null;
  loading: boolean;
  error: string | null;
  expandedIds: ReadonlySet<string>;
  bodies: Readonly<Record<string, BodyState>>;
  onToggleMessage: (messageId: string) => void;
  onOpenLink: (url: string) => void;
  onHandToAgent: (message: MessageHeader) => void;
  /** Back to the list; the button shows only when the page is one column wide. */
  onBack: () => void;
  /** Path of the folder being viewed; actions move this thread's messages in it. */
  folderPath: string;
  /** Special use of that folder: it decides which actions apply. */
  folderUse: SpecialUse | null;
  /** Display name of a folder path, for messages that live in another folder. */
  folderName: (path: string) => string;
  onAction: (action: MessageAction) => void;
  /** An action is in flight; the buttons wait. */
  actionPending: boolean;
  /** Messages whose remote images the owner chose to show this time. */
  remoteImageIds: ReadonlySet<string>;
  /** Lowercased senders allowed during this page session. */
  imageSenders: ReadonlySet<string>;
  onShowImages: (messageId: string) => void;
  onAlwaysShowImages: (message: MessageHeader) => void;
}

interface ToolbarAction {
  action: MessageAction;
  label: string;
  icon: string;
}

/**
 * The moves that make sense from a folder: Spam except in Spam, Not spam only
 * there, Archive except in Archive / All Mail, Delete except in Trash.
 */
export function actionsFor(use: SpecialUse | null): ToolbarAction[] {
  const actions: ToolbarAction[] = [];
  if (use === "junk") actions.push({ action: "not_spam", label: "Not spam", icon: "SecurityCheck" });
  if (use !== "archive" && use !== "all") {
    actions.push({ action: "archive", label: "Archive", icon: "Archive" });
  }
  if (use !== "junk") actions.push({ action: "spam", label: "Spam", icon: "AlertTriangle" });
  if (use !== "trash") actions.push({ action: "delete", label: "Delete", icon: "Trash2" });
  return actions;
}

function recipients(message: MessageHeader): string {
  const parts: string[] = [];
  if (message.to.length > 0) parts.push(`To ${message.to.map(addressLabel).join(", ")}`);
  if (message.cc.length > 0) parts.push(`Cc ${message.cc.map(addressLabel).join(", ")}`);
  return parts.join(" · ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ImageProps {
  remoteImages: boolean;
  onShowImages: () => void;
  onAlwaysShowImages: () => void;
}

function MessageBodyView({
  state,
  title,
  senderAddress,
  onOpenLink,
  images,
}: {
  state: BodyState | undefined;
  title: string;
  senderAddress: string | null;
  onOpenLink: (url: string) => void;
  images: ImageProps;
}) {
  if (state === undefined || state.status === "loading") {
    return <LoadingState label="Loading message…" />;
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.error}
      </p>
    );
  }
  return (
    <MessageFrame
      body={state.body}
      title={title}
      onOpenLink={onOpenLink}
      remoteImages={images.remoteImages}
      onShowImages={images.onShowImages}
      senderAddress={senderAddress}
      onAlwaysShowImages={images.onAlwaysShowImages}
    />
  );
}

function MessageItem({
  message,
  expanded,
  body,
  otherFolder,
  onToggle,
  onOpenLink,
  images,
}: {
  message: MessageHeader;
  expanded: boolean;
  body: BodyState | undefined;
  /** Name of the folder this copy lives in when it is not the one viewed. */
  otherFolder: string | null;
  onToggle: () => void;
  onOpenLink: (url: string) => void;
  images: ImageProps;
}) {
  const sender = addressLabel(message.from);
  const senderAddress = message.from.address.trim() !== "" ? message.from.address : null;
  const attachments = message.attachments.filter((a) => !a.isInline);
  return (
    <article
      aria-label={`Message from ${sender}`}
      className="rounded-lg border border-border bg-card"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm text-foreground",
                !message.isRead && "font-semibold",
              )}
            >
              {sender}
              {expanded && message.from.name ? (
                <span className="ml-1 font-normal text-muted-foreground">
                  &lt;{message.from.address}&gt;
                </span>
              ) : null}
            </span>
            {otherFolder !== null ? (
              <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-muted-foreground">
                {otherFolder}
              </span>
            ) : null}
            {message.date !== null ? (
              <time dateTime={message.date} className="shrink-0 text-xs text-muted-foreground">
                {formatFullDate(message.date)}
              </time>
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {expanded ? recipients(message) : message.snippet}
          </span>
        </button>
      </div>
      {expanded ? (
        <div className="flex flex-col gap-3 px-3 pb-3">
          <MessageBodyView
            state={body}
            title={`Message from ${sender}`}
            senderAddress={senderAddress}
            onOpenLink={onOpenLink}
            images={images}
          />
          {attachments.length > 0 ? (
            <ul aria-label="Attachments" className="flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <li
                  key={attachment.partId}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
                >
                  <Icon name="Paperclip" className="size-3.5" aria-hidden />
                  <span className="max-w-48 truncate text-foreground">
                    {attachment.filename ?? "Unnamed attachment"}
                  </span>
                  <span>{formatSize(attachment.size)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** The message Hand to agent gives: the newest one open, else the newest. */
function messageToHand(messages: MessageHeader[], expandedIds: ReadonlySet<string>) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (expandedIds.has(messages[i]!.id)) return messages[i]!;
  }
  return messages.at(-1) ?? null;
}

export function ReadingPane({
  detail,
  loading,
  error,
  expandedIds,
  bodies,
  onToggleMessage,
  onOpenLink,
  onHandToAgent,
  onBack,
  folderPath,
  folderUse,
  folderName,
  onAction,
  actionPending,
  remoteImageIds,
  imageSenders,
  onShowImages,
  onAlwaysShowImages,
}: ReadingPaneProps) {
  const back = (
    <div className="@3xl:hidden">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <Icon name="ArrowLeft" aria-hidden />
        Back
      </Button>
    </div>
  );

  if (detail === null) {
    return (
      <div className="flex flex-col gap-3 p-4">
        {back}
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : loading ? (
          <LoadingState label="Loading conversation…" />
        ) : null}
      </div>
    );
  }

  const { thread, messages } = detail;
  const inFolder = messages.some((m) => m.folder === folderPath);
  const handed = messageToHand(messages, expandedIds);
  return (
    <div className="box-border flex w-full min-w-0 flex-col gap-3 px-4 pb-6 pt-2">
      <div
        role="toolbar"
        aria-label="Conversation actions"
        className="flex flex-wrap items-center gap-1 border-b border-border pb-2"
      >
        {back}
        {inFolder
          ? actionsFor(folderUse).map(({ action, label, icon }) => (
              <Button
                key={action}
                variant="ghost"
                size="sm"
                disabled={actionPending}
                onClick={() => onAction(action)}
              >
                <Icon name={icon} aria-hidden />
                {label}
              </Button>
            ))
          : null}
        <span className="flex-1" />
        {handed !== null ? (
          <Button variant="ghost" size="sm" onClick={() => onHandToAgent(handed)}>
            <Icon name="Bot" aria-hidden />
            Hand to agent
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">
          {subjectOrPlaceholder(thread.subject)}
        </h2>
        <p className="text-xs text-muted-foreground">
          {messages.length === 1 ? "1 message" : `${messages.length} messages`}
        </p>
      </div>
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          expanded={expandedIds.has(message.id)}
          body={bodies[message.id]}
          otherFolder={message.folder !== folderPath ? folderName(message.folder) : null}
          onToggle={() => onToggleMessage(message.id)}
          onOpenLink={onOpenLink}
          images={{
            remoteImages:
              remoteImageIds.has(message.id) ||
              imageSenders.has(message.from.address.trim().toLowerCase()),
            onShowImages: () => onShowImages(message.id),
            onAlwaysShowImages: () => onAlwaysShowImages(message),
          }}
        />
      ))}
    </div>
  );
}
