// Schedule a meeting, or start one right now.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { NewMeeting } from "../core/model.ts";

const DURATIONS = [15, 30, 45, 60, 90, 120] as const;

interface CreateMeetingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeZone: string;
  /** Resolves when the meeting exists; rejects with the message to show. */
  onCreate: (input: NewMeeting, joinNow: boolean) => Promise<void>;
}

export function CreateMeetingDialog({ open, onOpenChange, timeZone, onCreate }: CreateMeetingDialogProps) {
  const [topic, setTopic] = useState("");
  const [when, setWhen] = useState("");
  const [duration, setDuration] = useState<number>(30);
  const [busy, setBusy] = useState<"schedule" | "instant" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(mode: "schedule" | "instant") {
    const cleanTopic = topic.trim();
    if (cleanTopic === "") return setError("Укажите тему встречи");
    let startTime: string | null = null;
    if (mode === "schedule") {
      const start = when === "" ? Number.NaN : new Date(when).getTime();
      if (Number.isNaN(start)) return setError("Укажите дату и время начала");
      startTime = new Date(start).toISOString();
    }
    setBusy(mode);
    setError(null);
    try {
      await onCreate({ topic: cleanTopic, startTime, durationMinutes: duration, timeZone }, mode === "instant");
      setTopic("");
      setWhen("");
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось создать встречу");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => busy === null && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новая встреча</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("schedule");
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Тема
            <Input autoFocus value={topic} maxLength={200} onChange={(event) => setTopic(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              Начало
              <Input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Длительность
              <select
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value))}
              >
                {DURATIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} мин
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">Время в поясе {timeZone}.</p>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void submit("instant")}>
              {busy === "instant" ? "Создаю…" : "Начать сейчас"}
            </Button>
            <Button type="submit" disabled={busy !== null}>
              {busy === "schedule" ? "Создаю…" : "Запланировать"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
