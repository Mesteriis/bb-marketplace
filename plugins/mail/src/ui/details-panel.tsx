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

/** What message_source returns. */
export interface MessageSource {
  headers: [string, string][];
  structure: string[];
  size: number;
  uid: number;
  folder: string;
  accountEmail: string;
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
}

export function DetailsPanel({ details, onClose, onCopy }: DetailsPanelProps) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const source = details?.status === "ready" ? details.source : null;

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
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>Message details</DialogTitle>
          <DialogDescription>
            Headers and structure as the server has them. Viewing them does not mark the message read.
          </DialogDescription>
        </DialogHeader>
        {details === null ? null : details.status === "loading" ? (
          <LoadingState label="Loading details…" />
        ) : details.status === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {details.error}
          </p>
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-muted-foreground">Account</dt>
              <dd className="truncate text-foreground">{details.source.accountEmail}</dd>
              <dt className="text-muted-foreground">Folder</dt>
              <dd className="truncate text-foreground">{details.source.folder}</dd>
              <dt className="text-muted-foreground">UID</dt>
              <dd className="text-foreground">{details.source.uid}</dd>
              <dt className="text-muted-foreground">Size</dt>
              <dd className="text-foreground">{formatBytes(details.source.size)}</dd>
            </dl>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                <Icon name="Copy" fallback="Check" aria-hidden />
                Copy
              </Button>
              <span role="status" className="text-xs text-muted-foreground">
                {copied === "copied" ? "Copied" : copied === "failed" ? "Could not copy" : ""}
              </span>
            </div>
            <pre
              aria-label="Headers"
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
              aria-label="Structure"
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
