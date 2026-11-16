// The card an agent's mail_triage opens in its thread (slice 3e). It shows
// what the store says about each proposed message (sender, subject, date,
// account) beside the frozen action and the agent's note, grouped by
// action, one checkbox per item. Every item starts ticked except
// Unsubscribe, which confirms an address to the sender; a snooze in an
// account without a snooze folder waits for its own "Create a folder" tick.
// Only the ticked items run, through the owner's own paths, after a click on
// Apply: the host's submit shortcut never applies (as on the 3c card).
//
// Everything here came from mail or from an agent, so it is plain text: no
// HTML, no links, hidden characters taken out.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TriageItemView, TriageView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { shownText } from "./agent-send-card.tsx";
import { formatFullDate, formatUntil, subjectOrPlaceholder } from "./thread-list.tsx";
import { FOREIGN_MAILTO_NOTE, MailtoPreview, UNSUBSCRIBE_PRIVACY } from "./unsubscribe-dialog.tsx";

export type TriageAction = TriageItemView["action"];

export type TriageViewResult =
  | { state: "ready"; view: TriageView; viewToken: string }
  | { state: "confirming" | "applying" | "applied" | "cancelled" | "changed" | "expired" | "interrupted" | "gone" };

/** What the card hands to the form: the ticked positions and the folders to create. */
export interface TriageSelection {
  approved: number[];
  createSnoozeFolder: string[];
}

/** The groups in the order the card shows them. */
export const TRIAGE_GROUPS: readonly { action: TriageAction; label: string }[] = [
  { action: "archive", label: "Archive" },
  { action: "mark_read", label: "Mark read" },
  { action: "snooze", label: "Snooze" },
  { action: "spam", label: "Move to Spam" },
  { action: "unsubscribe", label: "Unsubscribe" },
  { action: "reply", label: "Reply" },
];

const CLOSED_TEXT: Record<Exclude<TriageViewResult["state"], "ready">, string> = {
  confirming: "This batch was already answered.",
  applying: "This batch is being applied.",
  applied: "This batch was already applied.",
  cancelled: "Cancelled. Nothing was applied.",
  changed: "This batch changed after the agent proposed it. Nothing was applied.",
  expired: "This batch expired. Nothing was applied.",
  interrupted: "A restart interrupted this; check your Inbox.",
  gone: "This batch is no longer available. Nothing was applied.",
};

/** Ticked by default: every available item but Unsubscribe. */
export function defaultTicks(view: TriageView): Set<number> {
  return new Set(view.items.filter((item) => item.available && item.action !== "unsubscribe").map((item) => item.position));
}

/** An item can be ticked: available, and a snooze's account has (or will get) its folder. */
export function itemEnabled(item: TriageItemView, view: TriageView, folders: ReadonlySet<string>): boolean {
  if (!item.available) return false;
  if (item.action !== "snooze") return true;
  return !view.needsFolder.some((need) => need.accountId === item.accountId) || folders.has(item.accountId);
}

/** The positions Apply sends: ticked and enabled. */
export function approvedPositions(view: TriageView, ticks: ReadonlySet<number>, folders: ReadonlySet<string>): number[] {
  return view.items
    .filter((item) => ticks.has(item.position) && itemEnabled(item, view, folders))
    .map((item) => item.position)
    .sort((a, b) => a - b);
}

/** The folders Apply asks to create: ticked, for accounts with at least one approved snooze. */
export function foldersToCreate(view: TriageView, approved: readonly number[], folders: ReadonlySet<string>): string[] {
  const snoozing = new Set(
    view.items.filter((item) => item.action === "snooze" && approved.includes(item.position)).map((item) => item.accountId),
  );
  return view.needsFolder.map((need) => need.accountId).filter((id) => folders.has(id) && snoozing.has(id));
}

type Loaded =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "closed"; state: Exclude<TriageViewResult["state"], "ready"> }
  | { kind: "ready"; view: TriageView; viewToken: string };

export interface TriageCardProps {
  /** triage_view: the content and a fresh view token. */
  load(): Promise<TriageViewResult>;
  /** The form's submit with the card's choice and its view token; resolves once the host took it. */
  submit(selection: TriageSelection, viewToken: string): Promise<void>;
  /** The host's own cancellation of the form. */
  cancel(): void | Promise<void>;
  /** The host's form shortcuts; the card answers only cancel. */
  registerAction?: (handler: (action: string) => boolean) => () => void;
}

export function TriageCard({ load, submit, cancel, registerAction }: TriageCardProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [ticks, setTicks] = useState<ReadonlySet<number>>(new Set());
  const [folders, setFolders] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"apply" | "cancel" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      const result = await loadRef.current();
      if (result.state === "ready") {
        setLoaded({ kind: "ready", view: result.view, viewToken: result.viewToken });
        setTicks(defaultTicks(result.view));
        setFolders(new Set());
      } else {
        setLoaded({ kind: "closed", state: result.state });
      }
    } catch {
      setLoaded({ kind: "error" });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const doCancel = useCallback(async () => {
    setBusy("cancel");
    try {
      await cancel();
    } catch {
      setBusy(null);
    }
  }, [cancel]);

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

  const ready = loaded.kind === "ready" ? loaded : null;
  const approved = ready === null ? [] : approvedPositions(ready.view, ticks, folders);

  const apply = useCallback(async () => {
    if (ready === null || approved.length === 0) return;
    setBusy("apply");
    setFailure(null);
    try {
      await submit({ approved, createSnoozeFolder: foldersToCreate(ready.view, approved, folders) }, ready.viewToken);
    } catch {
      setFailure("Could not apply these actions. Nothing was applied; check the card again.");
      setBusy(null);
      void reload();
    }
  }, [approved, folders, ready, reload, submit]);

  if (loaded.kind === "loading") {
    return (
      <CardShell>
        <p className="text-sm text-muted-foreground">Loading the inbox actions…</p>
      </CardShell>
    );
  }
  if (loaded.kind === "error" || loaded.kind === "closed") {
    return (
      <CardShell>
        <p role="alert" className="text-sm text-foreground">
          {loaded.kind === "error" ? "Could not load these inbox actions. Nothing was applied." : CLOSED_TEXT[loaded.state]}
        </p>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void doCancel()}>
            Cancel
          </Button>
        </div>
      </CardShell>
    );
  }

  const { view } = loaded;
  const toggle = (position: number, on: boolean) =>
    setTicks((prev) => {
      const next = new Set(prev);
      if (on) next.add(position);
      else next.delete(position);
      return next;
    });
  const setGroup = (items: readonly TriageItemView[], on: boolean) =>
    setTicks((prev) => {
      const next = new Set(prev);
      for (const item of items) {
        if (!item.available) continue;
        if (on) next.add(item.position);
        else next.delete(item.position);
      }
      return next;
    });

  return (
    <CardShell>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="Bot" fallback="Mail" className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold text-foreground">
          {view.items.length === 1 ? "Review 1 inbox action" : `Review ${view.items.length} inbox actions`}
        </h3>
      </div>
      {view.summary !== null && view.summary !== "" ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium text-muted-foreground">Agent's summary</p>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{shownText(view.summary)}</p>
        </div>
      ) : null}

      {view.needsFolder.length > 0 ? (
        <section aria-label="Snooze folders" className="flex flex-col gap-1 rounded-md bg-muted/50 px-2 py-1.5">
          {view.needsFolder.map((need) => {
            const text = `Create a '${shownText(need.proposedName)}' folder in ${shownText(need.accountEmail)}`;
            return (
              <label key={need.accountId} className="flex items-start gap-2 text-sm text-foreground">
                <Checkbox
                  aria-label={text}
                  className="mt-0.5"
                  checked={folders.has(need.accountId)}
                  onCheckedChange={(value) =>
                    setFolders((prev) => {
                      const next = new Set(prev);
                      if (value === true) next.add(need.accountId);
                      else next.delete(need.accountId);
                      return next;
                    })
                  }
                />
                <span>{text}</span>
              </label>
            );
          })}
          <p className="text-xs text-muted-foreground">Snoozes in that account wait for its folder.</p>
        </section>
      ) : null}

      {TRIAGE_GROUPS.map(({ action, label }) => {
        const items = view.items.filter((item) => item.action === action);
        if (items.length === 0) return null;
        return (
          <section key={action} aria-label={label} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="min-w-0 flex-1 text-xs font-semibold text-foreground">
                {label} <span className="font-normal text-muted-foreground">{items.length}</span>
              </h4>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setGroup(items, true)}>
                Select all
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setGroup(items, false)}>
                Select none
              </Button>
            </div>
            {action === "unsubscribe" ? <p className="text-xs text-muted-foreground">{UNSUBSCRIBE_PRIVACY}</p> : null}
            {action === "reply" ? (
              <p className="text-xs text-muted-foreground">
                A tick lets the agent draft that reply; each reply comes back as its own card.
              </p>
            ) : null}
            <ul className="flex flex-col gap-1.5">
              {items.map((item) => (
                <TriageItemRow
                  key={item.position}
                  item={item}
                  enabled={itemEnabled(item, view, folders)}
                  checked={ticks.has(item.position) && itemEnabled(item, view, folders)}
                  onToggle={(on) => toggle(item.position, on)}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {failure !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void doCancel()}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy !== null || approved.length === 0} onClick={() => void apply()}>
          {busy === "apply" ? "Applying…" : `Apply ${approved.length}`}
        </Button>
      </div>
    </CardShell>
  );
}

function TriageItemRow({
  item,
  enabled,
  checked,
  onToggle,
}: {
  item: TriageItemView;
  enabled: boolean;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const subject = subjectOrPlaceholder(shownText(item.subject));
  const sender = item.fromName !== null && item.fromName.trim() !== "" ? shownText(item.fromName) : null;
  return (
    <li
      aria-label={subject}
      className={cn("flex items-start gap-2 rounded-md border border-border px-2 py-1.5", !enabled && "opacity-60")}
    >
      <Checkbox
        aria-label={`Include ${subject}`}
        className="mt-0.5"
        checked={checked}
        disabled={!enabled}
        onCheckedChange={(value) => onToggle(value === true)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="min-w-0 break-words text-sm text-foreground">
          {sender !== null ? <span className="font-medium">{sender} </span> : null}
          <span className="break-all text-muted-foreground">{shownText(item.fromAddress)}</span>
        </p>
        <p className="min-w-0 break-words text-sm text-foreground">{subject}</p>
        <p className="text-xs text-muted-foreground">
          {[formatFullDate(item.date), shownText(item.accountEmail), shownText(item.folder)].filter((part) => part !== "").join(" · ")}
        </p>
        {item.action === "snooze" && item.snoozeUntil !== null ? (
          <p className="text-xs text-foreground">Until {formatUntil(item.snoozeUntil)}</p>
        ) : null}
        {item.action === "unsubscribe" && item.unsubscribe !== null ? (
          <p className="break-all text-xs text-foreground">
            {item.unsubscribe.method === "one_click"
              ? `One click to ${shownText(item.unsubscribe.host ?? "")}`
              : `An email to ${shownText(item.unsubscribe.address ?? "")}`}
          </p>
        ) : null}
        {item.action === "unsubscribe" && item.unsubscribe?.method === "mailto" && item.unsubscribe.mailto !== null ? (
          <>
            {item.unsubscribe.mailto.foreignDomain ? (
              <p role="note" className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {FOREIGN_MAILTO_NOTE}
              </p>
            ) : null}
            <MailtoPreview
              subject={item.unsubscribe.mailto.subject}
              body={item.unsubscribe.mailto.body}
              hiddenChars={item.unsubscribe.mailto.hiddenChars}
            />
          </>
        ) : null}
        {item.note !== null && item.note !== "" ? (
          <AgentNote>{shownText(item.note)}</AgentNote>
        ) : null}
        {!item.available ? (
          <p className="text-xs text-destructive">{item.reason !== null ? shownText(item.reason) : "No longer available"}</p>
        ) : null}
      </div>
    </li>
  );
}

function AgentNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-0.5 border-l-2 border-border pl-2">
      <p className="text-xs font-medium text-muted-foreground">Agent's note</p>
      <p className="whitespace-pre-wrap break-words text-xs text-foreground">{children}</p>
    </div>
  );
}

function CardShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-question-form
      aria-label="Inbox actions proposed by an agent"
      role="group"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground"
    >
      {children}
    </div>
  );
}
