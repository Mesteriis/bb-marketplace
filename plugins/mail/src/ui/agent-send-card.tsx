// The confirmation card an agent's mail_propose opens in its thread (slice
// 3c). It shows the whole message the server froze: full addresses with
// their warnings, the Bcc row always, the body as plain text, the links in
// the agent's text and the attachments. Send queues exactly that; Open in
// Mail turns it into an ordinary draft; Cancel discards it.
//
// Everything on the card came from an agent and may be shaped by a message
// it read, so it is text only: no HTML, no links, no agent display names.
// The dwell, the acknowledgements and the scroll gate are card UX; the
// server's submit check (proposal id, content hash, one-time view token) is
// what decides.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ProposalView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatBytes } from "./attachments-input.tsx";
import { presendIssueText } from "./presend-dialog.tsx";
import { subjectOrPlaceholder } from "./thread-list.tsx";

export type ProposalViewResult =
  | { state: "ready"; view: ProposalView; viewToken: string }
  | { state: "changed" | "gone" | "opened_elsewhere" };

/** Send stays disabled this long after the content renders. */
export const SEND_DWELL_MS = 1_500;
/** A recipient row shows this many before "and N more" (RECIPIENT_ROW_COLLAPSE in the core). */
export const ROW_COLLAPSE = 10;

export interface AgentSendCardProps {
  /** proposal_view: the content and a fresh view token. */
  load(): Promise<ProposalViewResult>;
  /** The form's submit with the card's value; resolves once the host took it. */
  submit(action: "send" | "open", viewToken: string): Promise<void>;
  /** The host's own cancellation of the form. */
  cancel(): void | Promise<void>;
  /** Open the draft in the Mail page's composer (after Open in Mail). */
  openDraft(draftId: string): void;
  /**
   * The host's form shortcuts. The card handles only cancel; the handler
   * returns false for submit, which never presses Send.
   */
  registerAction?: (handler: (action: string) => boolean) => () => void;
}

/**
 * Invisible characters (format characters, variation selectors, line and
 * paragraph separators, Hangul fillers and other invisible marks); the same
 * pattern as the server's revealHidden (spec resolutions 13 and 20), which a
 * test compares over every code point.
 */
const HIDDEN =
  /[\p{Cf}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u2028\u2029\u3164\u115F\u1160\uFFA0\u034F\u17B4\u17B5\u180B-\u180F]/gu;

/** What the card shows of a text that came from an agent or a message. */
export function shownText(text: string): string {
  return text.replace(HIDDEN, "");
}

/** The file name's last extension (".exe"), or null; shown on its own so a long or padded name cannot hide it. */
export function extensionOf(fileName: string): string | null {
  const name = fileName.trimEnd();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot);
  return /\s/.test(ext) ? null : ext.toLowerCase();
}

const KIND_LABELS: Record<ProposalView["kind"], string> = {
  new: "New",
  reply: "Reply",
  reply_all: "Reply all",
  forward: "Forward",
};

const CLOSED_TEXT: Record<"changed" | "gone" | "opened_elsewhere", string> = {
  changed: "This proposal changed after it was made and cannot be sent.",
  gone: "This proposal is no longer available. Nothing was sent.",
  opened_elsewhere: "This card was opened elsewhere; reopen it.",
};

type Loaded =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "closed"; state: "changed" | "gone" | "opened_elsewhere" }
  | { kind: "ready"; view: ProposalView; viewToken: string };

type Recipient = ProposalView["to"][number];
type RecipientFlag = Recipient["flags"][number];

const key = (address: string) => address.trim().toLowerCase();

export function AgentSendCard({ load, submit, cancel, openDraft, registerAction }: AgentSendCardProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [dwellDone, setDwellDone] = useState(false);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [needsScroll, setNeedsScroll] = useState(false);
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [busy, setBusy] = useState<"send" | "open" | "cancel" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    loadRef.current().then(
      (result) => {
        if (!live) return;
        setLoaded(result.state === "ready" ? { kind: "ready", view: result.view, viewToken: result.viewToken } : { kind: "closed", state: result.state });
      },
      () => {
        if (live) setLoaded({ kind: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const ready = loaded.kind === "ready" ? loaded : null;

  useEffect(() => {
    if (ready === null) return;
    setDwellDone(false);
    const timer = setTimeout(() => setDwellDone(true), SEND_DWELL_MS);
    return () => clearTimeout(timer);
  }, [ready?.viewToken]);

  // The scroll gate only for a body taller than its box.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (ready === null || el === null) return;
    const taller = el.scrollHeight > el.clientHeight + 1;
    setNeedsScroll(taller);
    setScrolledToEnd(!taller);
  }, [ready?.viewToken]);

  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (el !== null && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) setScrolledToEnd(true);
  }, []);

  const view = ready?.view ?? null;
  const newAddresses = view === null
    ? []
    : [...view.to, ...view.cc, ...view.bcc].filter((r) => r.flags.includes("new")).map((r) => key(r.address));
  const unacknowledged = newAddresses.filter((a) => !acknowledged.has(a));
  const sendEnabled = ready !== null && busy === null && dwellDone && unacknowledged.length === 0 && scrolledToEnd;

  const acknowledge = useCallback((addresses: readonly string[]) => {
    setAcknowledged((prev) => {
      const next = new Set(prev);
      for (const address of addresses) next.add(key(address));
      return next;
    });
  }, []);

  const doCancel = useCallback(async () => {
    setBusy("cancel");
    try {
      await cancel();
    } catch {
      setBusy(null);
    }
  }, [cancel]);

  const doSubmit = useCallback(
    async (action: "send" | "open") => {
      if (ready === null) return;
      setBusy(action);
      setFailure(null);
      try {
        await submit(action, ready.viewToken);
        if (action === "open") openDraft(ready.view.draftId);
      } catch {
        setFailure(action === "send" ? "Could not send the answer. Nothing was sent." : "Could not open the message in Mail.");
        setBusy(null);
      }
    },
    [openDraft, ready, submit],
  );

  // The host's form shortcuts: only Cancel. The submit shortcut never
  // presses Send; Send takes a click (or Enter) on the Send button itself.
  const actions = useRef({ doCancel });
  actions.current = { doCancel };
  useEffect(() => {
    if (registerAction === undefined) return;
    return registerAction((action) => {
      if (action === "cancel") {
        void actions.current.doCancel();
        return true;
      }
      return false;
    });
  }, [registerAction]);

  if (loaded.kind === "loading") {
    return (
      <CardShell>
        <p className="text-sm text-muted-foreground">Loading the email…</p>
      </CardShell>
    );
  }

  if (loaded.kind === "error" || loaded.kind === "closed") {
    return (
      <CardShell>
        <p role="alert" className="text-sm text-foreground">
          {loaded.kind === "error" ? "Could not load this email. Nothing was sent." : CLOSED_TEXT[loaded.state]}
        </p>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void doCancel()}>
            Cancel
          </Button>
        </div>
      </CardShell>
    );
  }

  const v = loaded.view;
  const gateText = !dwellDone
    ? null
    : unacknowledged.length > 0
      ? "Confirm each new address to enable Send."
      : !scrolledToEnd
        ? "Scroll to the end of the message to enable Send."
        : null;

  return (
    <CardShell>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="Bot" fallback="Mail" className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold text-foreground">An agent proposes an email</h3>
        <span className="rounded-sm border border-border px-1.5 text-xs text-muted-foreground">{KIND_LABELS[v.kind]}</span>
      </div>
      {v.source !== null ? (
        <p className="text-xs text-muted-foreground">
          {v.kind === "forward" ? "Forwards" : "Replies to"} “{subjectOrPlaceholder(shownText(v.source.subject))}” from{" "}
          <span className="text-foreground">{shownText(v.source.fromAddress)}</span>
        </p>
      ) : null}

      {v.hiddenChars > 0 ? (
        <p role="note" className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {v.hiddenChars === 1 ? "1 hidden character removed" : `${v.hiddenChars} hidden characters removed`} (invisible
          marks in the subject, the addresses or the text).
        </p>
      ) : null}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">From</dt>
        <dd className="min-w-0 break-all text-foreground">
          {v.fromName !== null ? <span>{shownText(v.fromName)} </span> : null}
          <span className="text-muted-foreground">&lt;{v.account.address}&gt;</span>
          {v.fromAlias ? (
            <span className="ml-1.5 rounded-sm border border-border px-1 text-xs text-muted-foreground">alias</span>
          ) : null}
        </dd>
        <RecipientRow label="To" list={v.to} acknowledged={acknowledged} onAcknowledge={acknowledge} />
        <RecipientRow label="Cc" list={v.cc} acknowledged={acknowledged} onAcknowledge={acknowledge} />
        <RecipientRow
          label="Bcc"
          list={v.bcc}
          acknowledged={acknowledged}
          onAcknowledge={acknowledge}
          notice={v.bcc.length > 0 ? "Hidden recipients — the others will not see them" : null}
        />
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="min-w-0 break-words font-medium text-foreground">{subjectOrPlaceholder(shownText(v.subject))}</dd>
      </dl>

      {v.templateName !== null ? (
        <p className="text-xs text-muted-foreground">
          Includes the template «<span className="text-foreground">{shownText(v.templateName)}</span>»
        </p>
      ) : null}
      <div
        ref={bodyRef}
        onScroll={onBodyScroll}
        data-testid="agent-send-body"
        className="max-h-80 overflow-y-auto rounded-md border border-border bg-background px-3 py-2"
      >
        <div className="whitespace-pre-wrap break-words text-sm text-foreground">{shownText(v.bodyText)}</div>
        {v.signatureText !== null ? (
          // `-- ` only when the signature is the last thing (a new message); above a quote it is a block of its own.
          <div data-testid="agent-send-signature" className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">
            {v.quoteText === null ? <span className="block text-muted-foreground">{"-- "}</span> : null}
            {shownText(v.signatureText)}
          </div>
        ) : null}
        {v.quoteText !== null ? (
          <div className="mt-2">
            <button
              type="button"
              aria-expanded={quoteOpen}
              onClick={() => setQuoteOpen((open) => !open)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Icon name={quoteOpen ? "ChevronDown" : "ChevronRight"} fallback="Mail" className="size-3.5" aria-hidden />
              Quoted message (from the original)
            </button>
            {quoteOpen ? (
              <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs text-muted-foreground">
                {shownText(v.quoteText)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <section aria-label="Links" className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">Links in the text</h4>
        {v.links.length === 0 ? (
          <p className="text-xs text-muted-foreground">No links</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {v.links.map((link) => (
              <li key={link.url} className="min-w-0 break-all text-xs">
                <span className="font-semibold text-foreground">{shownText(link.host)}</span>{" "}
                <span className="text-muted-foreground">{shownText(link.url)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Attachments" className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">Attachments</h4>
        {v.attachments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No attachments</p>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {v.attachments.map((a, i) => (
                <li key={`${i}-${a.fileName}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                  <span className="min-w-0 whitespace-pre-wrap break-all text-foreground">{shownText(a.fileName)}</span>
                  <span className="shrink-0 rounded-sm border border-border px-1 font-medium text-foreground">
                    {extensionOf(shownText(a.fileName)) ?? "no extension"}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{a.mimeType}</span>
                  <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">From the forwarded message</p>
          </>
        )}
        {v.leftOut > 0 ? (
          <p className="text-xs text-muted-foreground">
            Left out: too large ({v.leftOut === 1 ? "1 attachment" : `${v.leftOut} attachments`})
          </p>
        ) : null}
      </section>

      {v.checks.length > 0 ? (
        <section aria-label="Before sending" className="flex flex-col gap-1 rounded-md bg-muted/50 px-2 py-1.5">
          <h4 className="text-xs font-medium text-foreground">Before sending</h4>
          <ul className="flex flex-col gap-0.5">
            {v.checks.map((issue, index) => (
              <li key={`${issue.kind}-${index}`} className="flex items-start gap-1.5 text-xs text-foreground">
                <Icon name="TriangleAlert" fallback="Info" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 break-words">{shownText(presendIssueText(issue).text)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {failure !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
      {gateText !== null ? <p className="text-xs text-muted-foreground">{gateText}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void doCancel()}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void doSubmit("open")}>
          Open in Mail
        </Button>
        <Button size="sm" disabled={!sendEnabled} onClick={() => void doSubmit("send")}>
          <Icon name="Send" fallback="Mail" aria-hidden />
          {busy === "send" ? "Sending…" : "Send"}
        </Button>
      </div>
    </CardShell>
  );
}

function CardShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-question-form
      aria-label="Email proposed by an agent"
      role="group"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground"
    >
      {children}
    </div>
  );
}

const FLAG_LABELS: Record<RecipientFlag, string> = {
  new: "New address",
  added: "Added by the agent",
  outside: "Outside your domains",
  hidden_chars: "Hidden characters",
};

const QUIET_FLAGS: ReadonlySet<RecipientFlag> = new Set(["outside"]);

/** A recipient with any flag is never collapsed away, and leads its row. */
const isFlagged = (r: Recipient) => r.flags.length > 0;

/**
 * What a row shows: every flagged recipient first (always, collapsed or
 * not), then the unflagged ones; a collapsed row cuts only the unflagged ones
 * to fill ROW_COLLAPSE. `hidden` is how many unflagged ones were cut.
 */
export function rowRecipients(list: readonly Recipient[], expanded: boolean): { shown: Recipient[]; hidden: number } {
  const flagged = list.filter(isFlagged);
  const quiet = list.filter((r) => !isFlagged(r));
  if (expanded || list.length <= ROW_COLLAPSE) return { shown: [...flagged, ...quiet], hidden: 0 };
  const room = Math.max(0, ROW_COLLAPSE - flagged.length);
  return { shown: [...flagged, ...quiet.slice(0, room)], hidden: quiet.length - room };
}

function RecipientRow({
  label,
  list,
  acknowledged,
  onAcknowledge,
  notice = null,
}: {
  label: string;
  list: readonly Recipient[];
  acknowledged: ReadonlySet<string>;
  onAcknowledge: (addresses: readonly string[]) => void;
  notice?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = list.length > ROW_COLLAPSE;
  const { shown } = rowRecipients(list, expanded);
  const { hidden } = rowRecipients(list, false);
  // The bulk acknowledgement covers only what is on screen right now.
  const newOnes = shown.filter((r) => r.flags.includes("new") && !acknowledged.has(key(r.address)));
  const warning = notice !== null;
  return (
    <>
      <dt className={cn("text-muted-foreground", warning && "text-destructive")}>{label}</dt>
      <dd
        aria-label={label}
        className={cn("flex min-w-0 flex-col gap-1", warning && "rounded-md bg-destructive/10 px-2 py-1")}
      >
        {warning ? <p className="text-xs font-medium text-destructive">{notice}</p> : null}
        {list.length === 0 ? (
          <span className="text-muted-foreground">none</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {shown.map((r) => (
              <RecipientChip
                key={r.address}
                recipient={r}
                acknowledged={acknowledged.has(key(r.address))}
                onAcknowledge={long ? null : () => onAcknowledge([r.address])}
              />
            ))}
          </ul>
        )}
        {long && hidden > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {expanded ? "Show fewer" : `and ${hidden} more`}
          </button>
        ) : null}
        {long && newOnes.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 self-start px-2"
            onClick={() => onAcknowledge(newOnes.map((r) => r.address))}
          >
            {newOnes.length === 1 ? "I know this address" : `I know these ${newOnes.length} addresses`}
          </Button>
        ) : null}
      </dd>
    </>
  );
}

function RecipientChip({
  recipient,
  acknowledged,
  onAcknowledge,
}: {
  recipient: Recipient;
  acknowledged: boolean;
  /** Null in a long row: one bulk acknowledgement covers it. */
  onAcknowledge: (() => void) | null;
}) {
  const isNew = recipient.flags.includes("new");
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="min-w-0 break-all font-medium text-foreground">{shownText(recipient.address)}</span>
      {recipient.name !== null && recipient.name.trim() !== "" ? (
        <span className="min-w-0 break-words text-xs text-muted-foreground">{shownText(recipient.name)}</span>
      ) : null}
      {recipient.flags.map((flag) => (
        <span
          key={flag}
          className={cn(
            "rounded-sm px-1 text-xs",
            QUIET_FLAGS.has(flag) ? "border border-border text-muted-foreground" : "bg-destructive/10 text-destructive",
          )}
        >
          {FLAG_LABELS[flag]}
        </span>
      ))}
      {isNew && !acknowledged && onAcknowledge !== null ? (
        <Button variant="outline" size="sm" className="h-6 px-2" onClick={onAcknowledge}>
          I know this address
        </Button>
      ) : null}
      {isNew && acknowledged ? <span className="text-xs text-muted-foreground">Confirmed</span> : null}
    </li>
  );
}
