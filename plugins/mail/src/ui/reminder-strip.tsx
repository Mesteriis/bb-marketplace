// Reply reminders (slice 3f): the "Waiting for a reply" strip atop the Inbox
// lists sent messages that got no reply in time, and "Remind me..." sets one
// on a Sent message. Local only: the server checks replies by In-Reply-To
// and References of later mail; nothing is written to the mail server.
import { useEffect, useState, type FormEvent } from "react";
import type { ReminderView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { stopEscape } from "./shortcuts.ts";
import { addressLabel, formatListDate, subjectOrPlaceholder } from "./thread-list.tsx";
import { tx } from "./i18n/index.ts";

export const REMINDER_DAYS_MIN = 1;
export const REMINDER_DAYS_MAX = 30;

/** Days typed by the owner, or null when out of range. */
export function reminderDays(value: string): number | null {
  if (!/^\d{1,2}$/.test(value.trim())) return null;
  const days = Number(value.trim());
  return days >= REMINDER_DAYS_MIN && days <= REMINDER_DAYS_MAX ? days : null;
}

export function daysText(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

export interface ReminderStripProps {
  reminders: readonly ReminderView[];
  /** replyReminderDays: Remind in N days. */
  defaultDays: number;
  onOpen: (reminder: ReminderView) => void;
  onSnooze: (reminder: ReminderView, days: number) => void;
  onDismiss: (reminder: ReminderView) => void;
}

export function ReminderStrip({ reminders, defaultDays, onOpen, onSnooze, onDismiss }: ReminderStripProps) {
  if (reminders.length === 0) return null;
  return (
    <section aria-label={tx("Waiting for a reply")} className="flex shrink-0 flex-col gap-1 border-b border-border bg-card px-3 py-2">
      <h3 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Icon name="Clock" fallback="Info" className="size-3.5" aria-hidden />
        {tx("Waiting for a reply")}
      </h3>
      <ul className="flex flex-col gap-1">
        {reminders.map((reminder) => (
          <li key={reminder.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-foreground">{reminder.recipient !== null ? addressLabel(reminder.recipient) : tx("Unknown recipient")}</span>
              <span className="text-muted-foreground">{` \u00b7 ${subjectOrPlaceholder(reminder.subject)}`}</span>
              {reminder.sentAt !== null ? (
                <span className="text-xs text-muted-foreground">{` \u00b7 sent ${formatListDate(reminder.sentAt)}`}</span>
              ) : null}
            </span>
            <span className="flex shrink-0 gap-1">
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={reminder.threadId === null} onClick={() => onOpen(reminder)}>
                {tx("Open")}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onSnooze(reminder, defaultDays)}>
                {tx("Remind in {p1}", { p1: daysText(defaultDays) })}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onDismiss(reminder)}>
                {tx("Dismiss")}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Remind me..." on a Sent message: how many days to wait for a reply. */
export function RemindDialog({
  open,
  defaultDays,
  onRemind,
  onCancel,
  onCloseAutoFocus,
}: {
  open: boolean;
  defaultDays: number;
  onRemind: (days: number) => void;
  onCancel: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [value, setValue] = useState(String(defaultDays));
  useEffect(() => {
    if (open) setValue(String(defaultDays));
  }, [defaultDays, open]);
  const days = reminderDays(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (days !== null) onRemind(days);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape} onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>{tx("Remind me if no reply")}</DialogTitle>
            <DialogDescription>
              {tx("Makosh Mail shows this message under Waiting for a reply when no reply arrives in time.")}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm text-foreground">
            {tx("After")}
            <Input
              aria-label={tx("Days")}
              inputMode="numeric"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="h-8 w-16"
            />
            {tx("days")}
          </label>
          {days === null ? <p className="text-xs text-destructive">{tx("From 1 to 30 days.")}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {tx("Cancel")}
            </Button>
            <Button type="submit" disabled={days === null}>
              {tx("Remind me")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
