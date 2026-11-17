// Details: one message's raw headers and MIME structure from the server, as
// plain text. Everything here is React text, never markup, so a header that
// holds HTML shows as the characters it is.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { stopEscape } from "./shortcuts.ts";
import { Icon } from "@/components/ui/icon";
import { LoadingState } from "./empty-states.tsx";
import { tx } from "./i18n/index.ts";

/** What message_source returns. */
export interface MessageSource {
  headers: [string, string][];
  structure: string[];
  size: number;
  uid: number;
  folder: string;
  accountEmail: string;
  /** Slice 3i: the provider's results, fixed-format lines (absent from older fixtures). */
  authenticity?: { authserv: string | null; lines: string[] };
}

export type DetailsState =
  | { messageId: string; status: "loading" }
  | { messageId: string; status: "ready"; source: MessageSource }
  | { messageId: string; status: "error"; error: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The text the Copy button puts on the clipboard. */
export function sourceText(source: MessageSource): string {
  const headers = source.headers.map(([name, value]) => `${name}: ${value}`).join("\n");
  return `${headers}\n\n${source.structure.join("\n")}\n`;
}

export interface DetailsPanelProps {
  details: DetailsState | null;
  onClose: () => void;
  /** Resolves true once the clipboard holds the text. */
  onCopy: (text: string) => Promise<boolean>;
  /** Where focus goes when the panel closes (it has no trigger to return to). */
  onCloseAutoFocus?: (event: Event) => void;
  /** The compact (drawer) layout's close hook. */
  onAfterCloseAutoFocus?: () => void;
  /** Slice 3i: Check again (sender_check_refresh with force); absent: not offered. */
  onCheckAgain?: (messageId: string) => Promise<void>;
}

/** "Authenticity (from mx.google.com): SPF pass (example.com) \u00b7 DMARC pass"; the lines alone without an authserv-id. */
export function authenticityText(authenticity: { authserv: string | null; lines: string[] }): string {
  const lines = authenticity.lines.join(" \u00b7 ");
  return authenticity.authserv !== null ? `Authenticity (from ${authenticity.authserv}): ${lines}` : `Authenticity: ${lines}`;
}

export function DetailsPanel({ details, onClose, onCopy, onCloseAutoFocus, onAfterCloseAutoFocus, onCheckAgain }: DetailsPanelProps) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [checking, setChecking] = useState<"idle" | "running" | "failed">("idle");
  const source = details?.status === "ready" ? details.source : null;

  async function checkAgain(messageId: string) {
    if (onCheckAgain === undefined) return;
    setChecking("running");
    try {
      await onCheckAgain(messageId);
      setChecking("idle");
    } catch {
      setChecking("failed");
    }
  }

  async function copy() {
    if (source === null) return;
    setCopied((await onCopy(sourceText(source))) ? "copied" : "failed");
  }

  return (
    <Dialog
      open={details !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied("idle");
          setChecking("idle");
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto" onEscapeKeyDown={stopEscape}
        onCloseAutoFocus={onCloseAutoFocus}
        onAfterCloseAutoFocus={onAfterCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{tx("Message details")}</DialogTitle>
          <DialogDescription>
            {tx("Headers and structure as the server has them. Viewing them does not mark the message read.")}
          </DialogDescription>
        </DialogHeader>
        {details === null ? null : details.status === "loading" ? (
          <LoadingState label={tx("Loading details\u2026")} />
        ) : details.status === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {details.error}
          </p>
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            {details.source.authenticity !== undefined && details.source.authenticity.lines.length > 0 ? (
              <div role="group" aria-label={tx("Authenticity")} className="flex flex-wrap items-center gap-2 text-xs">
                <p className="min-w-0 flex-1 break-words text-foreground">{authenticityText(details.source.authenticity)}</p>
                {onCheckAgain !== undefined ? (
                  <Button variant="outline" size="sm" disabled={checking === "running"} onClick={() => void checkAgain(details.messageId)}>
                    {tx("Check again")}
                  </Button>
                ) : null}
                {checking === "failed" ? (
                  <span role="alert" className="text-destructive">
                    {tx("Could not check again")}
                  </span>
                ) : null}
              </div>
            ) : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-muted-foreground">{tx("Account")}</dt>
              <dd className="truncate text-foreground">{details.source.accountEmail}</dd>
              <dt className="text-muted-foreground">{tx("Folder")}</dt>
              <dd className="truncate text-foreground">{details.source.folder}</dd>
              <dt className="text-muted-foreground">{tx("UID")}</dt>
              <dd className="text-foreground">{details.source.uid}</dd>
              <dt className="text-muted-foreground">{tx("Size")}</dt>
              <dd className="text-foreground">{formatBytes(details.source.size)}</dd>
            </dl>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                <Icon name="Copy" fallback="Check" aria-hidden />
                {tx("Copy")}
              </Button>
              <span role="status" className="text-xs text-muted-foreground">
                {copied === "copied" ? tx("Copied") : copied === "failed" ? tx("Could not copy") : ""}
              </span>
            </div>
            <pre
              aria-label={tx("Headers")}
              className="min-h-0 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-2 font-mono text-xs leading-relaxed text-foreground"
            >
              {details.source.headers.map(([name, value], index) => (
                <span key={index}>
                  <span className="text-muted-foreground">{name}:</span> {value}
                  {"\n"}
                </span>
              ))}
            </pre>
            <pre
              aria-label={tx("Structure")}
              className="overflow-auto whitespace-pre rounded-md border border-border bg-muted p-2 font-mono text-xs text-foreground"
            >
              {details.source.structure.join("\n")}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
