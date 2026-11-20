// Auto drafts (AI writes mail): the reply a model drafted for a message,
// shown next to it. Use opens an ordinary reply with the text in it;
// Dismiss forgets the draft. Nothing is sent from here.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { shownText } from "./agent-send-card.tsx";
import { aiLabel } from "./ai-text.tsx";
import { tx, txn } from "./i18n/index.ts";

export interface ReplyDraftShown {
  paragraphs: string[];
  preview: string;
  linksRemoved: number;
  provider: string;
  model: string;
}

export interface ReplyDraftPorts {
  /** The kept draft of a message, or null. */
  get: (messageId: string) => Promise<ReplyDraftShown | null>;
  /** Opens a reply to the message with the paragraphs as the owner's text. */
  use: (messageId: string, paragraphs: string[]) => Promise<void> | void;
  dismiss: (messageId: string) => Promise<void>;
}

export function ReplyDraftStrip({ messageId, ports }: { messageId: string; ports: ReplyDraftPorts }) {
  const [draft, setDraft] = useState<ReplyDraftShown | null>(null);
  // The page makes its ports anew on every render: the read follows the message, not the ports' identity.
  const latest = useRef(ports);
  latest.current = ports;
  useEffect(() => {
    let live = true;
    setDraft(null);
    latest.current.get(messageId).then(
      (found) => {
        if (live) setDraft(found);
      },
      // The strip is an offer: a failed read shows nothing.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [messageId]);
  if (draft === null) return null;
  const done = () => {
    setDraft(null);
    void ports.dismiss(messageId).catch(() => {});
  };
  return (
    <section
      aria-label={tx("Reply drafted")}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium text-foreground">{tx("Reply drafted")}</span>
        <span className="text-xs text-muted-foreground">{aiLabel(draft.provider, draft.model)}</span>
      </div>
      <p className="break-words text-sm text-foreground">{shownText(draft.preview)}</p>
      {draft.linksRemoved > 0 ? (
        <p className="text-xs text-muted-foreground">
          {txn(draft.linksRemoved, "{count} link you did not write was removed.", "{count} links you did not write were removed.")}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7"
          onClick={() => {
            void Promise.resolve(ports.use(messageId, draft.paragraphs.map(shownText))).then(done, () => {});
          }}
        >
          {tx("Use")}
        </Button>
        <Button variant="ghost" size="sm" className="h-7" onClick={done}>
          {tx("Dismiss")}
        </Button>
        <span className="text-xs text-muted-foreground">{tx("AI can be wrong; read the text before you send it.")}</span>
      </div>
    </section>
  );
}
