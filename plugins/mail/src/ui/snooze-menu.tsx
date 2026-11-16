// "Snooze until…" (slice 3e): the presets in local time (Later today,
// Tomorrow, This weekend, Next week) and Pick a date and time. The page
// sends the chosen moment as UTC ISO; the server checks the range again.
import { useEffect, useState, type FormEvent } from "react";
import { snoozePresets, validUntil } from "../core/snooze.ts";
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
import { formatUntil } from "./thread-list.tsx";

export const SNOOZE_RANGE_TEXT = "Pick a time from 5 minutes to a year from now.";

/** A `datetime-local` value ("2026-11-16T08:00") as a local Date; null when it is not one. */
export function parseLocalDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** A Date as a `datetime-local` value in local time. */
export function localDateTimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface SnoozeMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chosen moment, as UTC ISO. */
  onPick: (until: string) => void;
  /** How many conversations it snoozes, for the title. */
  count?: number;
  now?: () => Date;
  onCloseAutoFocus?: (event: Event) => void;
  onAfterCloseAutoFocus?: () => void;
}

export function SnoozeMenu({
  open,
  onOpenChange,
  onPick,
  count = 1,
  now = () => new Date(),
  onCloseAutoFocus,
  onAfterCloseAutoFocus,
}: SnoozeMenuProps) {
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
  const presets = snoozePresets(at, "local");

  const submitCustom = (event: FormEvent) => {
    event.preventDefault();
    const date = parseLocalDateTime(value);
    if (date === null || !validUntil(date.toISOString(), now())) {
      setProblem(SNOOZE_RANGE_TEXT);
      return;
    }
    onPick(date.toISOString());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xs"
        onEscapeKeyDown={stopEscape}
        onCloseAutoFocus={onCloseAutoFocus}
        onAfterCloseAutoFocus={onAfterCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{count > 1 ? `Snooze ${count} conversations until…` : "Snooze until…"}</DialogTitle>
          <DialogDescription>It leaves the Inbox and comes back unread at that time, while BB runs.</DialogDescription>
        </DialogHeader>
        <ul aria-label="Snooze times" className="flex flex-col gap-px">
          {presets.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                onClick={() => onPick(preset.at.toISOString())}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1 truncate">{preset.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatUntil(preset.at.toISOString(), at)}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              aria-expanded={picking}
              onClick={() => setPicking((open) => !open)}
              className="flex h-8 w-full items-center rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              Pick a date and time
            </button>
          </li>
        </ul>
        {picking ? (
          <form onSubmit={submitCustom} className="flex flex-col gap-2">
            <Input
              type="datetime-local"
              aria-label="Snooze until"
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
              Snooze
            </Button>
          </form>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
