// The body of a settled agent-triage card in the thread timeline (slice
// 3e). The persisted row keeps only the batch id; this reads where the
// batch stands now: "Applied N of M" with what ran per group, what was
// skipped or rate-limited, and Undo while the batch's undo record lives.
// The host renders this body only when the owner expands the row, so Undo
// is never one stray click on the timeline.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { tx } from "./i18n/index.ts";

export type TriageStatus = {
  state: "pending" | "confirming" | "applying" | "applied" | "cancelled" | "changed" | "expired" | "interrupted";
  total: number;
  approved: number;
  done: number;
  skipped: number;
  failed: number;
  rateLimited: number;
  byAction: { action: string; done: number }[];
  undoable: boolean;
};

const DONE_TEXT: Record<string, (n: number) => string> = {
  archive: (n) => `archived ${n}`,
  mark_read: (n) => `marked read ${n}`,
  snooze: (n) => `snoozed ${n}`,
  spam: (n) => `moved ${n} to Spam`,
  unsubscribe: (n) => `unsubscribe requested for ${n}`,
  reply: (n) => (n === 1 ? "1 reply approved" : `${n} replies approved`),
};

/** "Applied N of M" and the per-group counts of an applied batch. */
export function appliedText(status: TriageStatus): { head: string; groups: string; notes: string[] } {
  const replies = status.byAction.find((entry) => entry.action === "reply")?.done ?? 0;
  const head = tx("Applied {p1} of {total}", { p1: status.done + replies, total: status.total });
  const groups = status.byAction
    .filter((entry) => entry.done > 0 && DONE_TEXT[entry.action] !== undefined)
    .map((entry) => DONE_TEXT[entry.action]!(entry.done))
    .join(" · ");
  const notes: string[] = [];
  if (status.skipped > 0) notes.push(`${status.skipped} skipped (moved since)`);
  if (status.rateLimited > 0) notes.push(`${status.rateLimited} rate-limited, try later`);
  if (status.failed > 0) notes.push(`${status.failed} failed`);
  if ((status.byAction.find((entry) => entry.action === "unsubscribe")?.done ?? 0) > 0) {
    notes.push("Unsubscribe requests cannot be undone here");
  }
  return { head, groups, notes };
}

export interface TriageRowProps {
  /** triage_status; throws when the batch is no longer stored. */
  status(): Promise<TriageStatus>;
  /** action_undo of the batch; resolves with the result's text. */
  undo(): Promise<string>;
  /** Changes when mail changed (realtime): the row reads again. */
  version?: number;
}

type Loaded = { kind: "loading" } | { kind: "error" } | { kind: "ready"; status: TriageStatus };

export function TriageRow({ status, undo, version = 0 }: TriageRowProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [undoing, setUndoing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const serial = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  const reload = useCallback(async () => {
    const mine = ++serial.current;
    try {
      const s = await statusRef.current();
      if (mine === serial.current) setLoaded({ kind: "ready", status: s });
    } catch {
      if (mine === serial.current) setLoaded({ kind: "error" });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, version]);

  const onUndo = useCallback(async () => {
    setUndoing(true);
    setNote(null);
    try {
      setNote(await undo());
    } catch (error) {
      setNote(error instanceof Error && error.message ? error.message : "Could not undo");
    } finally {
      setUndoing(false);
      void reload();
    }
  }, [reload, undo]);

  if (loaded.kind === "loading") return <Line>{tx("Checking these inbox actions\u2026")}</Line>;
  if (loaded.kind === "error") return <Line>{tx("These inbox actions are no longer tracked here.")}</Line>;

  const s = loaded.status;
  let body: ReactNode;
  switch (s.state) {
    case "pending":
      body = <Line>{tx("Waiting for your review")}</Line>;
      break;
    case "confirming":
    case "applying":
      body = <Line>{tx("Applying\u2026")}</Line>;
      break;
    case "applied": {
      const { head, groups, notes } = appliedText(s);
      body = (
        <>
          <Line>
            <span className="text-foreground">{head}</span>
            {s.undoable ? (
              <Button variant="outline" size="sm" className="h-7 px-2" disabled={undoing} onClick={() => void onUndo()}>
                {tx("Undo")}
              </Button>
            ) : null}
          </Line>
          {groups !== "" ? <Line>{groups}</Line> : null}
          {notes.map((text) => (
            <Line key={text} warning={!text.startsWith("Unsubscribe")}>
              {text}
            </Line>
          ))}
        </>
      );
      break;
    }
    case "interrupted":
      body = <Line warning>{tx("A restart interrupted this; check your Inbox")}</Line>;
      break;
    case "cancelled":
      body = <Line>{tx("Cancelled. Nothing was applied.")}</Line>;
      break;
    case "changed":
      body = <Line>{tx("Not applied: the batch changed")}</Line>;
      break;
    case "expired":
      body = <Line>{tx("Expired. Nothing was applied.")}</Line>;
      break;
  }
  return (
    <div className="flex flex-col gap-1">
      {body}
      {note !== null ? (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}

function Line({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-sm", warning ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </div>
  );
}
