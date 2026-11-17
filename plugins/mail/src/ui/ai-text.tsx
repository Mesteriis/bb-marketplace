// What a model wrote, as the page shows it (slice 3f). A model read mail
// that may try to steer it, so its words are a React text child in pre-wrap:
// never HTML, Markdown or a link, invisible characters removed. The only
// interactive parts are the plugin's own citation chips, which map a frame
// number the plugin sent to a message it sent.
import type { ReactNode } from "react";
import type { AiResultView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { shownText } from "./agent-send-card.tsx";
import type { AiJobState, AiPhase } from "./ai-job.ts";
import { tx } from "./i18n/index.ts";

export type AiCitation = AiResultView["citations"][number];
export type AiNotes = AiResultView["notes"];

export const AI_CAUTION = "AI can be wrong; check the cited messages.";

/** "AI - <provider> - <model>", with "cached" for a stored answer. */
export function aiLabel(provider: string | null, model: string | null, cached = false): string {
  return [
    "AI",
    ...(provider !== null && provider !== "" ? [provider] : []),
    ...(model !== null && model !== "" ? [model] : []),
    ...(cached ? ["cached"] : []),
  ].join(" \u00b7 ");
}

/** The progress line of a running request. */
export function phaseText(phase: AiPhase | null, waiting: string): string {
  switch (phase) {
    case "planning":
      return "Searching your mail\u2026";
    case "reading":
      return "Reading the messages found\u2026";
    case "writing":
      return "Writing the answer\u2026";
    default:
      return waiting;
  }
}

/** Model text: plain, pre-wrap, invisible characters removed. */
export function AiText({ text, className }: { text: string; className?: string }) {
  return <span className={cn("whitespace-pre-wrap break-words", className)}>{shownText(text)}</span>;
}

/**
 * Chips for the frame numbers an item cites. Numbers the plugin did not
 * send (no citation maps them) are left out.
 */
export function CitationChips({
  numbers,
  citations,
  onCite,
}: {
  numbers: readonly number[];
  citations: readonly AiCitation[];
  onCite: (citation: AiCitation) => void;
}) {
  const seen = new Set<number>();
  const chips: AiCitation[] = [];
  for (const n of numbers) {
    if (seen.has(n)) continue;
    seen.add(n);
    const citation = citations.find((c) => c.n === n);
    if (citation !== undefined) chips.push(citation);
  }
  if (chips.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-baseline">
      {chips.map((citation) => (
        <button
          key={citation.n}
          type="button"
          aria-label={`Open cited message ${citation.n}`}
          onClick={() => onCite(citation)}
          className="rounded-sm border border-border px-1 text-xs leading-4 text-muted-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {citation.n}
        </button>
      ))}
    </span>
  );
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many.replace("#", String(count));
}

/** What did not reach the model, or could not be read back. */
export function notesText(notes: AiNotes): string[] {
  const lines: string[] = [];
  if (notes.hidden > 0) lines.push(plural(notes.hidden, "1 hidden value was not sent.", "# hidden values were not sent."));
  if (notes.leftOut > 0) {
    lines.push(plural(notes.leftOut, "1 message outside AI access was left out.", "# messages outside AI access were left out."));
  }
  if (notes.truncated > 0) {
    lines.push(plural(notes.truncated, "1 long message was cut or left out.", "# long messages were cut or left out."));
  }
  if (notes.unreadItems > 0) {
    lines.push(plural(notes.unreadItems, "1 item of the answer could not be read.", "# items of the answer could not be read."));
  }
  return lines;
}

export function AiNotesList({ notes }: { notes: AiNotes }) {
  const lines = notesText(notes);
  if (lines.length === 0) return null;
  return (
    <ul aria-label={tx("Notes")} className="flex flex-col text-xs text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** A failed request: the fixed text and makosh-ai's own words when it gave some. */
export function AiFailure({ state }: { state: Extract<AiJobState, { status: "failed" }> }) {
  return (
    <div role="alert" className="flex flex-col gap-0.5 text-xs text-destructive">
      <p>{state.text}</p>
      {state.gatewayMessage !== null && state.gatewayMessage !== "" ? (
        <p className="text-muted-foreground">{tx("Makosh AI says:")} {shownText(state.gatewayMessage)}</p>
      ) : null}
    </div>
  );
}

/** The frame every AI block shares: label, actions, body, caution. */
export function AiFrame({
  label,
  title,
  actions,
  children,
  caution = true,
}: {
  label: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  caution?: boolean;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="Sparkles" fallback="Bot" className="size-4 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">{label}</p>
        {actions}
      </div>
      {children}
      {caution ? <p className="text-xs text-muted-foreground">{AI_CAUTION}</p> : null}
    </section>
  );
}

/** A small action button of an AI block's header. */
export function AiAction({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}
