// The sender card (slice 3h, #86): who someone is in this mailbox, from the
// stored mail only. Its actions reuse earlier slices: search from the
// sender, always show their images, block, bind to a project, their files.
import type { SenderCard as SenderCardView, ThreadSummary } from "../core/index.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { formatFileSize } from "./files-view.tsx";
import { stopEscape } from "./shortcuts.ts";
import { formatListDate, subjectOrPlaceholder } from "./thread-list.tsx";
import { dateLocale, tx } from "./i18n/index.ts";

function formatDay(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
}

/** "48 from, 12 to - since 3 Mar 2025 - last ..." (the separators are middle dots). */
export function senderSummary(card: SenderCardView): string {
  const parts = [`${card.fromCount} from, ${card.toCount} to${card.toCapped ? " (in recent mail)" : ""}`];
  if (card.firstDate !== null) parts.push(`since ${formatDay(card.firstDate)}`);
  if (card.lastDate !== null) parts.push(`last ${formatListDate(card.lastDate)}`);
  return parts.join(" \u00b7 ");
}

export interface SenderCardActions {
  onSearch: (address: string) => void;
  onAlwaysShowImages?: () => void;
  onBlock?: () => void;
  onBindProject?: () => void;
  /** Split Inbox: a tab of this sender's mail. */
  onSplit?: () => void;
  onFiles: (address: string) => void;
  onOpenConversation: (thread: ThreadSummary) => void;
}

export function SenderCardDialog({
  address,
  card,
  error,
  actions,
  onClose,
}: {
  /** The address the card is for; null: closed. */
  address: string | null;
  /** sender_card's answer; null while it loads. */
  card: SenderCardView | null;
  error: string | null;
  actions: SenderCardActions;
  onClose: () => void;
}) {
  return (
    <Dialog open={address !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle className="truncate">{card?.name?.trim() || address || tx("Sender")}</DialogTitle>
          <DialogDescription className="truncate">{address ?? ""}</DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : card === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {tx("Loading\u2026")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{senderSummary(card)}</p>
            {card.blocked ? <p className="text-xs text-muted-foreground">{tx("Blocked: their mail goes to Spam.")}</p> : null}
            <div className="flex flex-wrap gap-1">
              <Button variant="outline" size="sm" className="h-7" onClick={() => actions.onSearch(card.address)}>
                <Icon name="Search" aria-hidden />
                {tx("Search from this sender")}
              </Button>
              <Button variant="ghost" size="sm" className="h-7" onClick={() => actions.onFiles(card.address)}>
                <Icon name="Paperclip" aria-hidden />
                {tx("Files")}
              </Button>
              {actions.onAlwaysShowImages !== undefined && !card.imagesAllowed ? (
                <Button variant="ghost" size="sm" className="h-7" onClick={actions.onAlwaysShowImages}>
                  <Icon name="Eye" fallback="Info" aria-hidden />
                  {tx("Always show images")}
                </Button>
              ) : null}
              {actions.onBindProject !== undefined ? (
                <Button variant="ghost" size="sm" className="h-7" onClick={actions.onBindProject}>
                  <Icon name="Folder" aria-hidden />
                  {tx("Bind to a project\u2026")}
                </Button>
              ) : null}
              {actions.onSplit !== undefined ? (
                <Button variant="ghost" size="sm" className="h-7" onClick={actions.onSplit}>
                  <Icon name="Columns3" fallback="Inbox" aria-hidden />
                  {tx("Split by this sender")}
                </Button>
              ) : null}
              {actions.onBlock !== undefined && !card.blocked ? (
                <Button variant="ghost" size="sm" className="h-7 text-destructive" onClick={actions.onBlock}>
                  <Icon name="Ban" fallback="AlertTriangle" aria-hidden />
                  {tx("Block\u2026")}
                </Button>
              ) : null}
            </div>
            {card.conversations.length > 0 ? (
              <section aria-label={tx("Conversations")} className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">{tx("Conversations")}</h3>
                <ul className="flex flex-col">
                  {card.conversations.map((thread) => (
                    <li key={thread.id}>
                      <button
                        type="button"
                        onClick={() => actions.onOpenConversation(thread)}
                        className="flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-state-hover"
                      >
                        <span className="min-w-0 flex-1 truncate">{subjectOrPlaceholder(thread.subject)}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{formatListDate(thread.lastDate)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {card.files.length > 0 ? (
              <section aria-label={tx("Files")} className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">{tx("Files")}</h3>
                <ul className="flex flex-col text-sm">
                  {card.files.map((file) => (
                    <li key={`${file.messageId}:${file.partId}`} className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">{file.filename ?? tx("Unnamed attachment")}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
