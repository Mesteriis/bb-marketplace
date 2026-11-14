// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/components/email/MessageItem.tsx, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// The right column: one conversation, messages oldest first. Collapsed
// messages show sender, date and snippet; an expanded one shows its body.
import type { MessageBody, MessageHeader, ThreadDetail } from "../core/index.ts";
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

function MessageBodyView({
  state,
  title,
  onOpenLink,
}: {
  state: BodyState | undefined;
  title: string;
  onOpenLink: (url: string) => void;
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
  return <MessageFrame body={state.body} title={title} onOpenLink={onOpenLink} />;
}

function MessageItem({
  message,
  expanded,
  body,
  onToggle,
  onOpenLink,
  onHandToAgent,
}: {
  message: MessageHeader;
  expanded: boolean;
  body: BodyState | undefined;
  onToggle: () => void;
  onOpenLink: (url: string) => void;
  onHandToAgent: () => void;
}) {
  const sender = addressLabel(message.from);
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
        {expanded ? (
          <Button variant="ghost" size="sm" onClick={onHandToAgent}>
            <Icon name="Bot" aria-hidden />
            Hand to agent
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div className="flex flex-col gap-3 px-3 pb-3">
          <MessageBodyView state={body} title={`Message from ${sender}`} onOpenLink={onOpenLink} />
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
  return (
    <div className="box-border flex w-full min-w-0 flex-col gap-3 px-4 pb-6 pt-3">
      <div className="flex flex-col gap-1">
        {back}
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
          onToggle={() => onToggleMessage(message.id)}
          onOpenLink={onOpenLink}
          onHandToAgent={() => onHandToAgent(message)}
        />
      ))}
    </div>
  );
}
