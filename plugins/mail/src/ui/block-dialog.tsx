// "Block" (slice 3e): block the sender's address, or everyone at their
// domain (not offered for public mail providers). It says when the owner
// has written to them, and how many stored Inbox messages would move to
// Spam; that box is ticked for an address and unticked for a domain (spec
// resolutions 6 and 24). Cancel has the focus. A rule moves mail to Spam
// and never deletes; it applies to every account.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { shownText } from "./agent-send-card.tsx";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

export type BlockKind = "address" | "domain";

/** block_check's answer. */
export type BlockCheck = {
  address: string;
  /** Null for a public mail domain. */
  domain: string | null;
  sentToCount: number;
  storedCount: { address: number; domain: number | null };
};

export interface BlockChoice {
  kind: BlockKind;
  moveExisting: boolean;
}

/** "You have written to this sender N times"; null when never. */
export function writtenToText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "You have written to this sender once." : `You have written to this sender ${count} times.`;
}

/** The move box's label for the chosen kind's count. */
export function moveExistingText(kind: BlockKind, count: number): string {
  const whom = kind === "address" ? "from them" : "from that domain";
  return count === 1
    ? `Also move the 1 stored message ${whom} to Spam`
    : `Also move the ${count} stored messages ${whom} to Spam`;
}

export interface BlockDialogProps {
  /** The message whose sender is blocked; null: closed. */
  messageId: string | null;
  /** block_check for the message. */
  load: (messageId: string) => Promise<BlockCheck>;
  onBlock: (messageId: string, choice: BlockChoice) => void;
  onCancel: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  onAfterCloseAutoFocus?: () => void;
}

type Loaded = { kind: "loading" } | { kind: "error"; text: string } | { kind: "ready"; check: BlockCheck };

export function BlockDialog({ messageId, load, onBlock, onCancel, onCloseAutoFocus, onAfterCloseAutoFocus }: BlockDialogProps) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [kind, setKind] = useState<BlockKind>("address");
  const [move, setMove] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (messageId === null) return;
    let live = true;
    setLoaded({ kind: "loading" });
    setKind("address");
    setMove(true);
    loadRef.current(messageId).then(
      (check) => {
        if (live) setLoaded({ kind: "ready", check });
      },
      (error: unknown) => {
        if (live) setLoaded({ kind: "error", text: error instanceof Error && error.message ? error.message : "Could not check this sender." });
      },
    );
    return () => {
      live = false;
    };
  }, [messageId]);

  const check = loaded.kind === "ready" ? loaded.check : null;
  const count = check === null ? 0 : kind === "address" ? check.storedCount.address : (check.storedCount.domain ?? 0);
  const written = check === null ? null : writtenToText(check.sentToCount);
  const choose = (next: BlockKind) => {
    setKind(next);
    // Spec resolution 6: ticked for an address, unticked for a domain.
    setMove(next === "address");
  };

  return (
    <Dialog
      open={messageId !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onEscapeKeyDown={stopEscape}
        onCloseAutoFocus={onCloseAutoFocus}
        onAfterCloseAutoFocus={onAfterCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{tx("Block this sender?")}</DialogTitle>
          <DialogDescription>
            {tx("New mail from them goes to Spam in every account while BB runs. Nothing is deleted.")}
          </DialogDescription>
        </DialogHeader>
        {loaded.kind === "loading" ? <p className="text-sm text-muted-foreground">{tx("Checking the sender\u2026")}</p> : null}
        {loaded.kind === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {loaded.text}
          </p>
        ) : null}
        {check !== null ? (
          <div className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="sr-only">{tx("What to block")}</legend>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name="block-kind"
                  className="mt-1"
                  checked={kind === "address"}
                  onChange={() => choose("address")}
                />
                <span className="min-w-0 break-all">{tx("Block")} {shownText(check.address)}</span>
              </label>
              {check.domain !== null ? (
                <label className="flex items-start gap-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name="block-kind"
                    className="mt-1"
                    checked={kind === "domain"}
                    onChange={() => choose("domain")}
                  />
                  <span className="min-w-0 break-all">{tx("Block everyone at")} {shownText(check.domain)}</span>
                </label>
              ) : null}
            </fieldset>
            {written !== null ? (
              <p role="note" className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {written}
              </p>
            ) : null}
            {count > 0 ? (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <Checkbox
                  checked={move}
                  onCheckedChange={(value) => setMove(value === true)}
                  className="mt-0.5"
                  aria-label={moveExistingText(kind, count)}
                />
                <span>{moveExistingText(kind, count)}</span>
              </label>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button ref={cancel} variant="outline" size="sm" onClick={onCancel}>
            {tx("Cancel")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={check === null || messageId === null}
            onClick={() => messageId !== null && onBlock(messageId, { kind, moveExisting: move && count > 0 })}
          >
            {tx("Block")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
