// "Send later" (slice 3l): the presets in local time (In an hour, This
// evening, Tomorrow morning, Tomorrow afternoon, Monday morning) and Pick a
// date and time. The composer sends the chosen moment as UTC ISO; the server
// checks the range again.
import { shownText } from "./agent-send-card.tsx";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { sendLaterPresets, validSendAt, type SendLaterPresetId } from "../core/send-later.ts";
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
import { stopEscape } from "./shortcuts.ts";
import { localDateTimeValue, parseLocalDateTime } from "./snooze-menu.tsx";
import { formatUntil } from "./thread-list.tsx";
import { msg, tx } from "./i18n/index.ts";

export const SEND_LATER_RANGE = msg("Pick a time from one minute to a year from now.");

const PRESET_LABELS: Record<SendLaterPresetId, string> = {
  in_an_hour: msg("In an hour"),
  this_evening: msg("This evening"),
  tomorrow_morning: msg("Tomorrow morning"),
  tomorrow_afternoon: msg("Tomorrow afternoon"),
  monday_morning: msg("Monday morning"),
};

export interface SendLaterMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chosen moment, as UTC ISO. */
  onPick: (at: string) => void;
  /** Smart send: the time the first recipient usually writes, asked when the menu opens; absent or null: no such row. */
  smart?: () => Promise<SmartSendTime | null>;
  now?: () => Date;
}

/** A send time taken from when the recipient usually writes. */
export interface SmartSendTime {
  at: string;
  hour: number;
  name: string;
}

/** "09:00" for an hour of the day. */
export function hourText(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function SendLaterMenu({ open, onOpenChange, onPick, smart, now = () => new Date() }: SendLaterMenuProps) {
  const [suggested, setSuggested] = useState<SmartSendTime | null>(null);
  const asked = useRef(smart);
  asked.current = smart;
  useEffect(() => {
    setSuggested(null);
    if (!open || asked.current === undefined) return;
    let live = true;
    asked.current().then(
      (found) => {
        // A time that passed while the menu was closed, or closer than a minute, is not offered.
        if (live && found !== null && validSendAt(found.at, now())) setSuggested(found);
      },
      // The row is an offer: without an answer the menu is as it always was.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open]);
  const [picking, setPicking] = useState(false);
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setPicking(false);
    setProblem(null);
    setValue(localDateTimeValue(new Date(now().getTime() + 3_600_000)));
  }, [open]);
  const at = now();

  const submitCustom = (event: FormEvent) => {
    event.preventDefault();
    // React events cross the portal: the submit must not reach the composer around the dialog.
    event.stopPropagation();
    const date = parseLocalDateTime(value);
    if (date === null || !validSendAt(date.toISOString(), now())) {
      setProblem(tx(SEND_LATER_RANGE));
      return;
    }
    onPick(date.toISOString());
  };

  const row =
    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>{tx("Send later")}</DialogTitle>
          <DialogDescription>
            {tx("Mail sends it at that time while BB runs. Until then it waits in the Outbox in Sent, where you can edit it.")}
          </DialogDescription>
        </DialogHeader>
        <ul aria-label={tx("Send times")} className="flex flex-col gap-px">
          {suggested !== null && validSendAt(suggested.at, at) ? (
            // Checked again at every render: a menu left open does not offer a time that has come too close.
            <li>
              <button type="button" onClick={() => onPick(suggested.at)} className={`${row} h-auto min-h-8 py-1`}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{tx("Smart send")}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {tx("{name} usually writes around {time}", { name: shownText(suggested.name), time: hourText(suggested.hour) })}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatUntil(suggested.at, at)}</span>
              </button>
            </li>
          ) : null}
          {sendLaterPresets(at).map((preset) => (
            <li key={preset.id}>
              <button type="button" onClick={() => onPick(preset.at.toISOString())} className={row}>
                <span className="min-w-0 flex-1 truncate">{tx(PRESET_LABELS[preset.id])}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatUntil(preset.at.toISOString(), at)}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" aria-expanded={picking} onClick={() => setPicking((shown) => !shown)} className={row}>
              {tx("Pick a date and time")}
            </button>
          </li>
        </ul>
        {picking ? (
          <form onSubmit={submitCustom} className="flex flex-col gap-2">
            <Input
              type="datetime-local"
              aria-label={tx("Send at")}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setProblem(null);
              }}
              className="h-8"
            />
            {problem !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {problem}
              </p>
            ) : null}
            <Button type="submit" size="sm" className="self-end">
              {tx("Schedule")}
            </Button>
          </form>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {tx("Cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
