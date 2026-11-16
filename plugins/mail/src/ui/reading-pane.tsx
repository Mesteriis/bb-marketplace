// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/components/email/MessageItem.tsx, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// The right column: one conversation, messages oldest first. Collapsed
// messages show sender, date and snippet; an expanded one shows its body.
// The toolbar acts on the conversation's messages in the folder (or role)
// being viewed; each message has its own flag, Details and downloads.
import { useEffect, type ReactNode } from "react";
import type {
  AttachmentMeta,
  MessageAction,
  MessageBody,
  MessageHeader,
  SpecialUse,
  ThreadDetail,
} from "../core/index.ts";
import type { BbLinkView, DevLinkView, UnsubscribeInfoView } from "../core/model.ts";
import type { ProjectListItem } from "../core/contract.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { LoadingState } from "./empty-states.tsx";
import { MessageFrame } from "./message-frame.tsx";
import { addressLabel, formatFullDate, formatUntil, subjectOrPlaceholder } from "./thread-list.tsx";
import { UNSUBSCRIBE_HIDDEN_HINT, preferredMethod } from "./unsubscribe-dialog.tsx";
import { projectName, type BbCall, type CodeRenderers } from "./bb-ports.ts";
import { AlertCard } from "./alert-card.tsx";
import { DevLinksStrip } from "./dev-links-strip.tsx";
import { PatchCard } from "./patch-dialog.tsx";
import { ProjectChip, type AlwaysChoice } from "./project-chip.tsx";

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
  /** Whether a message's copy sits in the folder (or role) being viewed; actions apply to those. */
  inView: (message: MessageHeader) => boolean;
  /** Special use of that folder (or the role): it decides which actions apply. */
  folderUse: SpecialUse | null;
  /** Whether the server would archive from here (core archiveAllowedFrom). */
  archiveAllowed: boolean;
  /** Display name of a message's folder, for copies that live elsewhere. */
  folderName: (message: MessageHeader) => string;
  onAction: (action: MessageAction) => void;
  /** Mark the conversation unread and go back to the list. */
  onMarkUnread: () => void;
  /** Open Move to… for the conversation. */
  onMoveTo: () => void;
  /** An action is in flight; the buttons wait. */
  actionPending: boolean;
  onToggleMessageFlag: (message: MessageHeader) => void;
  onDetails: (message: MessageHeader) => void;
  onDownloadEml: (message: MessageHeader) => void;
  onDownloadAttachment: (message: MessageHeader, attachment: AttachmentMeta) => void;
  /** Messages whose remote images the owner chose to show this time. */
  remoteImageIds: ReadonlySet<string>;
  /** Lowercased senders allowed during this page session. */
  imageSenders: ReadonlySet<string>;
  onShowImages: (messageId: string) => void;
  onAlwaysShowImages: (message: MessageHeader) => void;
  onStopImages: (message: MessageHeader) => void;
  /** Reply, Reply all or Forward to a message. */
  onCompose: (kind: "reply" | "reply_all" | "forward", message: MessageHeader) => void;
  /** Whether a message is a draft (ours, or in a Drafts folder): it gets Edit draft. */
  isDraft: (message: MessageHeader) => boolean;
  onEditDraft: (message: MessageHeader) => void;
  /** The composer under the conversation has focus: its toolbar is the one shown. */
  hideToolbar?: boolean;
  /** Translate in the toolbar and the translation block; absent: no Translate. */
  translation?: ReadingTranslation;
  /** Unsubscribe, Snooze and Block (slice 3e); absent: none of them. */
  inbox?: ReadingInbox;
  /** Summarize, Find tasks, the category line and Remind me (slice 3f); absent: none of them. */
  ai?: ReadingAi;
  /** Slice 3g: New thread, Make a task, the project, links, patches, alerts and saves; absent: none of them. */
  bb?: ReadingBb;
}

/** The reading pane's part of the BB integration (slice 3g). */
export interface ReadingBb {
  call: BbCall;
  /** The BB projects (null while unknown). */
  projects: readonly ProjectListItem[] | null;
  renderers: CodeRenderers;
  onNewThread: (message: MessageHeader) => void;
  onMakeTask: (message: MessageHeader) => void;
  onSetProject: (projectId: string | null) => void;
  onAlways: (choice: AlwaysChoice, projectId: string) => void;
  onOpenProject: (projectId: string) => void;
  onOpenThread: (bbThreadId: string) => void;
  /** New thread... from a link: its project and "Look at <url>". */
  onLinkThread: (message: MessageHeader, link: DevLinkView) => void;
  onSaveAttachments: (message: MessageHeader, attachments: AttachmentMeta[]) => void;
  onReviewPatch: (message: MessageHeader) => void;
  onIncident: (bbThreadId: string, appended: boolean) => void;
}

/** Each BB target once, oldest first, from the conversation's messages. */
export function linkedItems(messages: readonly MessageHeader[]): BbLinkView[] {
  const seen = new Set<string>();
  const items: BbLinkView[] = [];
  for (const message of messages) {
    for (const link of message.bbLinks ?? []) {
      const key = `${link.kind}:${link.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(link);
    }
  }
  return items;
}

function LinkedItems({ items, bb }: { items: readonly BbLinkView[]; bb: ReadingBb }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="In BB" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {items.map((item) => {
        const key = `${item.kind}:${item.targetId}`;
        if (item.kind === "taskboard_task") {
          return (
            <li key={key} className="flex items-center gap-1">
              <Icon name="ListChecks" fallback="Check" className="size-3.5" aria-hidden />
              <span>Task on Taskboard</span>
            </li>
          );
        }
        if (item.kind === "project_file") {
          return (
            <li key={key} className="flex min-w-0 items-center gap-1">
              <Icon name="Folder" className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">
                {`Saved to ${item.projectId !== null ? projectName(bb.projects, item.projectId) : "a project"}: ${item.targetId}`}
              </span>
            </li>
          );
        }
        const label = item.kind === "incident" ? "Incident thread" : item.kind === "patch" ? "Patch thread" : "Thread";
        return (
          <li key={key} className="flex min-w-0 items-center gap-1">
            <Icon name="Bot" className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{`${label}: ${item.title ?? "BB thread"}`}</span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => bb.onOpenThread(item.targetId)}>
              Open
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** The reading pane's part of the AI features (slice 3f). */
export interface ReadingAi {
  /** Why every AI button is off (Makosh AI is missing), or null. */
  disabledReason: string | null;
  onSummarize: () => void;
  onFindTasks: () => void;
  /** The summary block, shown under the subject; null when none is open. */
  summary: ReactNode | null;
  /** The category line; null with categories off. */
  category: ReactNode | null;
  /** Remind me... on a sent message; absent outside Sent. */
  onRemind?: (message: MessageHeader) => void;
  /** A cited message to bring into view and mark for a moment. */
  highlight: { messageId: string; serial: number } | null;
}

/** Why Summarize and Find tasks are off for a conversation, or null. */
export function conversationAiReason(messages: readonly MessageHeader[], disabledReason: string | null): string | null {
  if (!messages.some((m) => m.inAiScope)) return OUTSIDE_AI_ACCESS;
  return disabledReason;
}

/** The reading pane's part of inbox triage (slice 3e). */
export interface ReadingInbox {
  /** unsubscribe_info of the newest message; null while unknown or for none. */
  unsubscribe: UnsubscribeInfoView | null;
  onUnsubscribe: () => void;
  /** "Archive all from this list" after an unsubscribe request. */
  onArchiveList: () => void;
  onSnooze: () => void;
  onBlock: (message: MessageHeader) => void;
  /** "Return now" for a snoozed conversation. */
  onReturnNow: () => void;
}

/** An earlier request that still stands: Unsubscribe is not offered again. */
const SETTLED_UNSUBSCRIBE = new Set(["done", "queued", "sent"]);

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The reading pane's part of translation (slice 3c). */
export interface ReadingTranslation {
  /** Why Translate is disabled (its tooltip), or null. */
  disabledReason: string | null;
  /** The message whose translation is shown, and its block. */
  shown: { messageId: string; block: ReactNode } | null;
  /** Translate, or Show original when that message's translation is shown. */
  onToggle: (message: MessageHeader) => void;
}

interface ToolbarAction {
  action: MessageAction;
  label: string;
  icon: string;
}

/**
 * The moves that make sense from a folder: Spam except in Spam, Not spam only
 * there, Archive where the server allows it, Delete except in Trash.
 */
export function actionsFor(use: SpecialUse | null, archiveAllowed: boolean): ToolbarAction[] {
  const actions: ToolbarAction[] = [];
  if (use === "junk") actions.push({ action: "not_spam", label: "Not spam", icon: "SecurityCheck" });
  if (archiveAllowed) {
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
  /** The sender is allowed during this page session. */
  senderAllowed: boolean;
  onShowImages: () => void;
  onAlwaysShowImages: () => void;
  onStopImages: () => void;
}

function MessageBodyView({
  state,
  title,
  senderAddress,
  onOpenLink,
  images,
  renderers,
}: {
  state: BodyState | undefined;
  title: string;
  senderAddress: string | null;
  onOpenLink: (url: string) => void;
  images: ImageProps;
  renderers?: CodeRenderers;
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
      senderTrusted={images.senderAllowed || state.body.remoteImagesAllowed}
      onStopImages={images.onStopImages}
      {...(renderers !== undefined ? { renderers } : {})}
    />
  );
}

/** A short type for an attachment chip: the file's extension, else the MIME subtype. */
export function attachmentType(attachment: Pick<AttachmentMeta, "filename" | "mimeType">): string {
  const extension = attachment.filename?.match(/\.([A-Za-z0-9]{1,6})$/)?.[1];
  if (extension !== undefined) return extension.toUpperCase();
  const subtype = attachment.mimeType.split(";")[0]?.split("/")[1]?.trim() ?? "";
  const short = subtype.replace(/^(x-|vnd\.)/i, "").split(/[.+]/)[0] ?? "";
  return (short || "file").slice(0, 10).toUpperCase();
}

function AttachmentButton({
  attachment,
  onDownload,
  onSave,
}: {
  attachment: AttachmentMeta;
  onDownload: () => void;
  /** Slice 3g: Save to project...; absent: not offered. */
  onSave?: () => void;
}) {
  const name = attachment.filename ?? "Unnamed attachment";
  const type = attachmentType(attachment);
  return (
    <li className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onDownload}
        aria-label={`Download ${name}, ${type}, ${formatSize(attachment.size)}`}
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="Paperclip" className="size-3.5" aria-hidden />
        <span className="max-w-48 truncate text-foreground">{name}</span>
        <span>{type}</span>
        <span>{formatSize(attachment.size)}</span>
        <Icon name="Download" fallback="Paperclip" className="size-3.5" aria-hidden />
      </button>
      {onSave !== undefined ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label={`Save ${name} to project\u2026`}
          onClick={onSave}
        >
          <Icon name="FolderInput" fallback="Folder" aria-hidden />
        </Button>
      ) : null}
    </li>
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
  onToggleFlag,
  onDetails,
  onDownloadEml,
  onDownloadAttachment,
  onEditDraft,
  translation,
  highlighted = false,
  bb,
  projectId = null,
}: {
  message: MessageHeader;
  expanded: boolean;
  body: BodyState | undefined;
  /** Name of the folder this copy lives in when it is not the one viewed. */
  otherFolder: string | null;
  onToggle: () => void;
  onOpenLink: (url: string) => void;
  images: ImageProps;
  onToggleFlag: () => void;
  onDetails: () => void;
  onDownloadEml: () => void;
  onDownloadAttachment: (attachment: AttachmentMeta) => void;
  /** Set for a draft: continue it in the composer. */
  onEditDraft: (() => void) | null;
  /** This message's translation block, shown above its body. */
  translation: ReactNode | null;
  /** A citation points here: marked for a moment. */
  highlighted?: boolean;
  bb?: ReadingBb;
  /** The conversation's project (slice 3g). */
  projectId?: string | null;
}) {
  const sender = addressLabel(message.from);
  const senderAddress = message.from.address.trim() !== "" ? message.from.address : null;
  const attachments = message.attachments.filter((a) => !a.isInline);
  const inline = message.attachments.filter((a) => a.isInline);
  return (
    <article
      aria-label={`Message from ${sender}`}
      data-message-id={message.id}
      className={cn("rounded-lg border border-border bg-card", highlighted && "ring-2 ring-ring")}
    >
      <div className="flex items-start gap-1 px-3 py-2">
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
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "size-7 shrink-0",
            message.isFlagged ? "text-primary [&_svg]:fill-current" : "text-muted-foreground",
          )}
          aria-label="Flag message"
          aria-pressed={message.isFlagged}
          onClick={onToggleFlag}
        >
          <Icon name="Star" fallback="Check" aria-hidden />
        </Button>
      </div>
      {expanded ? (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {translation}
          {bb !== undefined ? (
            <DevLinksStrip
              links={message.devLinks ?? []}
              projectName={(id) => projectName(bb.projects, id)}
              onOpen={onOpenLink}
              onOpenProject={bb.onOpenProject}
              onNewThread={(link) => bb.onLinkThread(message, link)}
              inAiScope={message.inAiScope}
            />
          ) : null}
          {bb !== undefined && message.alert === true ? (
            <AlertCard
              messageId={message.id}
              inAiScope={message.inAiScope}
              projectId={projectId}
              call={bb.call}
              onOpenThread={bb.onOpenThread}
              onOpenLink={onOpenLink}
              onStarted={(id) => bb.onIncident(id, false)}
              onAppended={(id) => bb.onIncident(id, true)}
            />
          ) : null}
          {bb !== undefined && message.patch != null ? (
            <PatchCard patch={message.patch} onReview={() => bb.onReviewPatch(message)} />
          ) : null}
          <MessageBodyView
            state={body}
            title={`Message from ${sender}`}
            senderAddress={senderAddress}
            onOpenLink={onOpenLink}
            images={images}
            {...(bb !== undefined ? { renderers: bb.renderers } : {})}
          />
          {attachments.length > 0 ? (
            <ul aria-label="Attachments" className="flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <AttachmentButton
                  key={attachment.partId}
                  attachment={attachment}
                  onDownload={() => onDownloadAttachment(attachment)}
                  {...(bb !== undefined ? { onSave: () => bb.onSaveAttachments(message, [attachment]) } : {})}
                />
              ))}
            </ul>
          ) : null}
          {bb !== undefined && attachments.length > 1 ? (
            <div>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => bb.onSaveAttachments(message, attachments)}>
                <Icon name="FolderInput" fallback="Folder" aria-hidden />
                {"Save all to project\u2026"}
              </Button>
            </div>
          ) : null}
          {inline.length > 0 ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">
                {inline.length === 1 ? "1 inline part" : `${inline.length} inline parts`}
              </summary>
              <ul aria-label="Inline parts" className="mt-2 flex flex-wrap gap-2">
                {inline.map((attachment) => (
                  <AttachmentButton
                    key={attachment.partId}
                    attachment={attachment}
                    onDownload={() => onDownloadAttachment(attachment)}
                  />
                ))}
              </ul>
            </details>
          ) : null}
          <div className="flex flex-wrap items-center gap-1">
            {onEditDraft !== null ? (
              <Button variant="outline" size="sm" className="h-7 px-2" onClick={onEditDraft}>
                <Icon name="Pencil" fallback="Mail" aria-hidden />
                Edit draft
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onDetails}>
              <Icon name="Info" fallback="Folder" aria-hidden />
              Details
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onDownloadEml}>
              <Icon name="Download" fallback="Paperclip" aria-hidden />
              Download .eml
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/** Why Hand to agent and the AI buttons are off for a message outside the AI access scope (slice 3f). */
export const OUTSIDE_AI_ACCESS = "Outside AI access (Mail settings)";

/** The message Hand to agent (and Reply, r, a, f) takes: the newest one open, else the newest. */
export function messageToHand(messages: MessageHeader[], expandedIds: ReadonlySet<string>) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (expandedIds.has(messages[i]!.id)) return messages[i]!;
  }
  return messages.at(-1) ?? null;
}

export function ReadingPane(props: ReadingPaneProps) {
  const { detail, loading, error, expandedIds, bodies, onBack, folderUse, archiveAllowed } = props;
  const highlight = props.ai?.highlight ?? null;
  // A citation chip was clicked: its message comes into view.
  useEffect(() => {
    if (highlight === null || typeof document === "undefined") return;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))) {
      if (element.dataset.messageId === highlight.messageId) {
        element.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
        return;
      }
    }
  }, [highlight?.serial]);
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
  const inFolder = messages.some(props.inView);
  const handed = messageToHand(messages, expandedIds);
  const handedDraft = handed !== null && props.isDraft(handed);
  const inbox = props.inbox;
  // Block takes the sender of a received message: not in Sent or Drafts, not a draft.
  const blockable =
    handed !== null && !handedDraft && folderUse !== "sent" && folderUse !== "drafts" && handed.from.address.trim() !== ""
      ? handed
      : null;
  const unsubscribe = inbox?.unsubscribe ?? null;
  const already = unsubscribe?.already ?? null;
  const canUnsubscribe =
    preferredMethod(unsubscribe) !== null && (already === null || !SETTLED_UNSUBSCRIBE.has(already.state));
  return (
    <div className="box-border flex w-full min-w-0 flex-col gap-3 px-4 pb-6 pt-2">
      {props.hideToolbar !== true ? (
      <div
        role="toolbar"
        aria-label="Conversation actions"
        className="flex flex-wrap items-center gap-1 border-b border-border pb-2"
      >
        {back}
        {handed !== null && handedDraft ? (
          <Button variant="ghost" size="sm" onClick={() => props.onEditDraft(handed)}>
            <Icon name="Pencil" fallback="Mail" aria-hidden />
            Edit draft
          </Button>
        ) : null}
        {handed !== null && !handedDraft ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => props.onCompose("reply", handed)}>
              <Icon name="Reply" fallback="ArrowLeft" aria-hidden />
              Reply
            </Button>
            <Button variant="ghost" size="sm" onClick={() => props.onCompose("reply_all", handed)}>
              <Icon name="ReplyAll" fallback="ArrowLeft" aria-hidden />
              Reply all
            </Button>
            <Button variant="ghost" size="sm" onClick={() => props.onCompose("forward", handed)}>
              <Icon name="Forward" fallback="Send" aria-hidden />
              Forward
            </Button>
            {props.translation !== undefined ? (
              // A disabled button shows no tooltip of its own: the wrapper carries the reason.
              <span title={props.translation.disabledReason ?? undefined} className="inline-flex">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={props.translation.disabledReason !== null}
                  aria-description={props.translation.disabledReason ?? undefined}
                  onClick={() => props.translation?.onToggle(handed)}
                >
                  <Icon name="Languages" fallback="Mail" aria-hidden />
                  {props.translation.shown?.messageId === handed.id ? "Show original" : "Translate"}
                </Button>
              </span>
            ) : null}
          </>
        ) : null}
        {inFolder
          ? actionsFor(folderUse, archiveAllowed).map(({ action, label, icon }) => (
              <Button
                key={action}
                variant="ghost"
                size="sm"
                disabled={props.actionPending}
                onClick={() => props.onAction(action)}
              >
                <Icon name={icon} aria-hidden />
                {label}
              </Button>
            ))
          : null}
        {inFolder ? (
          <>
            <Button variant="ghost" size="sm" disabled={props.actionPending} onClick={props.onMoveTo}>
              <Icon name="Folder" aria-hidden />
              Move to…
            </Button>
            <Button variant="ghost" size="sm" disabled={props.actionPending} onClick={props.onMarkUnread}>
              <Icon name="Mail" aria-hidden />
              Mark unread
            </Button>
            {inbox !== undefined && folderUse === "inbox" ? (
              <Button variant="ghost" size="sm" disabled={props.actionPending} onClick={inbox.onSnooze}>
                <Icon name="Clock" fallback="Info" aria-hidden />
                Snooze
              </Button>
            ) : null}
          </>
        ) : null}
        {inbox !== undefined && blockable !== null ? (
          <Button variant="ghost" size="sm" disabled={props.actionPending} onClick={() => inbox.onBlock(blockable)}>
            <Icon name="Ban" fallback="AlertTriangle" aria-hidden />
            Block
          </Button>
        ) : null}
        {props.ai !== undefined && handed !== null && !handedDraft && props.ai.onRemind !== undefined ? (
          <Button variant="ghost" size="sm" onClick={() => props.ai?.onRemind?.(handed)}>
            <Icon name="Clock" fallback="Info" aria-hidden />
            {"Remind me\u2026"}
          </Button>
        ) : null}
        <span className="flex-1" />
        {props.bb !== undefined && handed !== null && !handedDraft ? (
          <>
            <span title={handed.inAiScope ? undefined : OUTSIDE_AI_ACCESS} className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                disabled={!handed.inAiScope}
                aria-keyshortcuts="Shift+N"
                onClick={() => props.bb?.onNewThread(handed)}
              >
                <Icon name="MessageSquarePlus" fallback="Bot" aria-hidden />
                {"New thread\u2026"}
              </Button>
            </span>
            <Button variant="ghost" size="sm" aria-keyshortcuts="Shift+K" onClick={() => props.bb?.onMakeTask(handed)}>
              <Icon name="ListPlus" fallback="ListChecks" aria-hidden />
              {"Make a task\u2026"}
            </Button>
          </>
        ) : null}
        {props.ai !== undefined ? (
          <AiButtons ai={props.ai} reason={conversationAiReason(messages, props.ai.disabledReason)} />
        ) : null}
        {handed !== null ? (
          <span title={handed.inAiScope ? undefined : OUTSIDE_AI_ACCESS} className="inline-flex">
            <Button variant="ghost" size="sm" disabled={!handed.inAiScope} onClick={() => props.onHandToAgent(handed)}>
              <Icon name="Bot" aria-hidden />
              Hand to agent
            </Button>
          </span>
        ) : null}
      </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start gap-2">
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-foreground">
            {subjectOrPlaceholder(thread.subject)}
          </h2>
          {inbox !== undefined && canUnsubscribe ? (
            <Button variant="outline" size="sm" className="h-7 shrink-0 px-2" onClick={inbox.onUnsubscribe}>
              Unsubscribe
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {messages.length === 1 ? "1 message" : `${messages.length} messages`}
        </p>
        {inbox !== undefined && thread.snoozedUntil !== null ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Icon name="Clock" fallback="Info" className="size-3.5" aria-hidden />
            <span>Snoozed until {formatUntil(thread.snoozedUntil)}</span>
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={inbox.onReturnNow}>
              Return now
            </Button>
          </div>
        ) : null}
        {inbox !== undefined && already !== null ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>You asked to unsubscribe on {formatDay(already.at)}</span>
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={inbox.onArchiveList}>
              Archive all from this list
            </Button>
          </div>
        ) : null}
        {inbox !== undefined && unsubscribe !== null && unsubscribe.hidden && unsubscribe.listName !== null ? (
          <p className="text-xs text-muted-foreground">{UNSUBSCRIBE_HIDDEN_HINT}</p>
        ) : null}
        {props.ai?.category ?? null}
        {props.bb !== undefined ? (
          <>
            <ProjectChip
              key={thread.id}
              detail={detail}
              projects={props.bb.projects}
              onSet={props.bb.onSetProject}
              onAlways={props.bb.onAlways}
              onOpenProject={props.bb.onOpenProject}
            />
            <LinkedItems items={linkedItems(messages)} bb={props.bb} />
          </>
        ) : null}
      </div>
      {props.ai?.summary ?? null}
      {messages.map((message) => {
        const sender = message.from.address.trim().toLowerCase();
        return (
          <MessageItem
            key={message.id}
            message={message}
            expanded={expandedIds.has(message.id)}
            body={bodies[message.id]}
            otherFolder={props.inView(message) ? null : props.folderName(message)}
            onToggle={() => props.onToggleMessage(message.id)}
            onOpenLink={props.onOpenLink}
            images={{
              remoteImages: props.remoteImageIds.has(message.id) || props.imageSenders.has(sender),
              senderAllowed: props.imageSenders.has(sender),
              onShowImages: () => props.onShowImages(message.id),
              onAlwaysShowImages: () => props.onAlwaysShowImages(message),
              onStopImages: () => props.onStopImages(message),
            }}
            onToggleFlag={() => props.onToggleMessageFlag(message)}
            onDetails={() => props.onDetails(message)}
            onDownloadEml={() => props.onDownloadEml(message)}
            onDownloadAttachment={(attachment) => props.onDownloadAttachment(message, attachment)}
            onEditDraft={props.isDraft(message) ? () => props.onEditDraft(message) : null}
            translation={props.translation?.shown?.messageId === message.id ? props.translation.shown.block : null}
            highlighted={highlight?.messageId === message.id}
            {...(props.bb !== undefined ? { bb: props.bb, projectId: detail.project?.id ?? null } : {})}
          />
        );
      })}
    </div>
  );
}

/** Summarize and Find tasks; off with the reason as the tooltip. */
function AiButtons({ ai, reason }: { ai: ReadingAi; reason: string | null }) {
  return (
    // A disabled button shows no tooltip of its own: the wrapper carries the reason.
    <span title={reason ?? undefined} className="inline-flex">
      <Button variant="ghost" size="sm" disabled={reason !== null} aria-description={reason ?? undefined} onClick={ai.onSummarize}>
        <Icon name="Sparkles" fallback="Bot" aria-hidden />
        Summarize
      </Button>
      <Button variant="ghost" size="sm" disabled={reason !== null} aria-description={reason ?? undefined} onClick={ai.onFindTasks}>
        <Icon name="ListChecks" fallback="Check" aria-hidden />
        Find tasks
      </Button>
    </span>
  );
}
