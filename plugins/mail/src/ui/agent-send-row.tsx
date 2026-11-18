// The body of a settled agent-send card in the thread timeline (slice 3c).
// The persisted row keeps only the proposal id; this reads where the email
// stands now: the outbox state with Undo while it waits, Sent, or Not sent
// with the draft to open in Mail. The host renders this body only when the
// owner expands the row, so Undo is never one stray click on the timeline.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { OutboxRow } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { outboxStateText } from "./outbox.tsx";
import { tx } from "./i18n/index.ts";

export type ProposalStatus = {
  state: "pending" | "confirming" | "queued" | "opened" | "cancelled" | "expired" | "refused";
  outboxId: string | null;
  draftId: string | null;
  reason: "rate_limited" | "too_large" | "account" | "changed" | null;
};

export interface AgentSendRowProps {
  /** proposal_status; throws when the proposal is no longer stored. */
  status(): Promise<ProposalStatus>;
  /** The outbox row by id, or null once it is done (or undone). */
  outbox(outboxId: string): Promise<OutboxRow | null>;
  /** outbox_cancel: false when it was too late. */
  undo(outboxId: string): Promise<boolean>;
  openDraft(draftId: string): void;
  /** Changes when the outbox changed (realtime): the row reads again. */
  version?: number;
  now?: () => number;
}

/** Why a confirmed card could not be queued (spec resolution 11). */
export const NOT_QUEUED_TEXT: Record<"rate_limited" | "too_large" | "account", string> = {
  rate_limited: "too many messages were sent in the last minute",
  too_large: "the attachments are over the size limit",
  account: "the account needs attention in Mail",
};

type Loaded =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; status: ProposalStatus; row: OutboxRow | null };

export function AgentSendRow({ status, outbox, undo, openDraft, version = 0, now = Date.now }: AgentSendRowProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [undoing, setUndoing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const serial = useRef(0);
  const ports = useRef({ status, outbox });
  ports.current = { status, outbox };

  const reload = useCallback(async () => {
    const mine = ++serial.current;
    try {
      const s = await ports.current.status();
      const row = s.outboxId !== null ? await ports.current.outbox(s.outboxId) : null;
      if (mine === serial.current) setLoaded({ kind: "ready", status: s, row });
    } catch {
      if (mine === serial.current) setLoaded({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, version]);

  const row = loaded.kind === "ready" ? loaded.row : null;
  const due = row !== null && row.state === "queued" ? Date.parse(row.sendAfter) : NaN;
  // The countdown ticks each second; at zero the row reads again.
  useEffect(() => {
    if (Number.isNaN(due)) return;
    const timer = setInterval(() => {
      if (now() >= due) {
        clearInterval(timer);
        void reload();
      }
      setTick((n) => n + 1);
    }, 1_000);
    return () => clearInterval(timer);
  }, [due, now, reload]);

  const onUndo = useCallback(
    async (outboxId: string) => {
      setUndoing(true);
      setNote(null);
      try {
        if (!(await undo(outboxId))) setNote("Too late to undo");
      } catch {
        setNote("Could not undo");
      } finally {
        setUndoing(false);
        void reload();
      }
    },
    [reload, undo],
  );

  if (loaded.kind === "loading") return <Line>{tx("Checking where this email stands\u2026")}</Line>;
  if (loaded.kind === "error") return <Line>{tx("This email is no longer tracked here. See the Outbox in Mail.")}</Line>;

  const { status: s } = loaded;
  const openButton =
    s.draftId !== null ? (
      <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => openDraft(s.draftId!)}>
        {tx("Open in Mail")}
      </Button>
    ) : null;

  let body: ReactNode;
  switch (s.state) {
    case "pending":
      body = <Line>{tx("Waiting for your review")}</Line>;
      break;
    case "confirming":
      body = <Line>{tx("Confirmed; queuing\u2026")}</Line>;
      break;
    case "queued":
      if (row === null) {
        body = <Line>{tx("Sent")}</Line>;
      } else if (row.state === "queued") {
        const left = Math.max(1, Math.ceil((due - now()) / 1000));
        body = (
          <Line>
            <span>{tx("Sending in")} {Number.isNaN(left) ? 10 : left} s</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              disabled={undoing}
              onClick={() => void onUndo(row.id)}
            >
              {tx("Undo")}
            </Button>
          </Line>
        );
      } else {
        const attention = row.state === "failed" || row.state === "unknown" || row.state === "sent_no_copy" || row.state === "held";
        body = <Line warning={attention}>{outboxStateText(row)}{attention ? tx(" \u00b7 see the Outbox in Mail") : ""}</Line>;
      }
      break;
    case "opened":
      body = (
        <Line warning={s.reason !== null && s.reason !== "changed"}>
          <span>
            {s.reason !== null && s.reason !== "changed"
              ? `Not sent · ${NOT_QUEUED_TEXT[s.reason]}`
              : tx("Not sent \u00b7 kept as a draft in Mail")}
          </span>
          {openButton}
        </Line>
      );
      break;
    case "refused":
      body = <Line>{tx("Not sent: the proposal changed")}</Line>;
      break;
    case "cancelled":
      body = <Line>{tx("Cancelled. Nothing was sent.")}</Line>;
      break;
    case "expired":
      body = <Line>{tx("Expired. Nothing was sent.")}</Line>;
      break;
  }
  return (
    <div className="flex flex-col gap-1">
      {body}
      {note !== null ? (
        <p role="alert" className="text-xs text-destructive">
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
