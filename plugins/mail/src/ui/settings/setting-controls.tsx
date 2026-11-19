// Rows of the settings page that save on change. Each shows the saved value,
// sends one key through the page's settings port, says "Saved" for a moment,
// and on a refusal goes back to the saved value and says why in the row.
// Writes of the whole page go one after another, in the order they were made.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { PageSettings, PageSettingsPatch } from "../../core/page-settings.ts";
import { tx } from "../i18n/index.ts";
import { SettingRow } from "./primitives.tsx";

export type SaveResult = { ok: true } | { ok: false; message: string };

/** The page's settings: null while they load. */
export type PageSettingsPort = {
  values: PageSettings | null;
  save: (patch: PageSettingsPatch) => Promise<SaveResult>;
};

type WritableKey = keyof PageSettingsPatch;
type KeysOf<T> = { [K in WritableKey]: PageSettings[K] extends T ? K : never }[WritableKey];

/** How long "Saved" stays next to a control. */
export const SAVED_NOTE_MS = 2_000;

/** One key of the port: the value to show, a change that saves it, and what to say about the last change. */
function useSetting<K extends WritableKey>(port: PageSettingsPort, name: K) {
  const saved = port.values === null ? undefined : port.values[name];
  const [pending, setPending] = useState<{ value: PageSettings[K] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const serial = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  async function change(value: PageSettings[K]) {
    const mine = ++serial.current;
    setPending({ value });
    setProblem(null);
    setNote(null);
    if (timer.current !== null) clearTimeout(timer.current);
    let result: SaveResult;
    try {
      result = await port.save({ [name]: value } as PageSettingsPatch);
    } catch {
      result = { ok: false, message: tx("The setting could not be saved.") };
    }
    // A newer change of this row decides what the row says.
    if (mine !== serial.current) return;
    setPending(null);
    if (result.ok) {
      setNote(tx("Saved"));
      timer.current = setTimeout(() => setNote(null), SAVED_NOTE_MS);
    } else {
      setProblem(result.message);
    }
  }

  return { value: pending !== null ? pending.value : saved, loading: port.values === null, change, note, problem };
}

type RowText = { label: string; hint?: string };

/** An on/off control: a real switch for the keyboard and screen readers. */
export function Switch({ id, checked, disabled, describedBy, label, onChange }: { id: string; checked: boolean; disabled?: boolean; describedBy?: string; /** For a switch with no label element (a table cell). */ label?: string; onChange: (next: boolean) => void }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span aria-hidden className={cn("inline-block size-3.5 rounded-full bg-background transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function SwitchSetting({ port, name, label, hint }: RowText & { port: PageSettingsPort; name: KeysOf<boolean> }) {
  const setting = useSetting(port, name);
  return (
    <SettingRow
      label={label}
      hint={hint}
      note={setting.loading ? tx("Loading…") : setting.note}
      problem={setting.problem}
      control={({ id, describedBy }) => (
        <Switch id={id} describedBy={describedBy} checked={setting.value === true} disabled={setting.loading} onChange={(next) => void setting.change(next as never)} />
      )}
    />
  );
}

export function SelectSetting<K extends KeysOf<string>>({
  port,
  name,
  label,
  hint,
  options,
}: RowText & { port: PageSettingsPort; name: K; options: readonly { value: PageSettings[K]; label: string }[] }) {
  const setting = useSetting(port, name);
  return (
    <SettingRow
      label={label}
      hint={hint}
      note={setting.loading ? tx("Loading…") : setting.note}
      problem={setting.problem}
      control={({ id, describedBy }) => (
        <Select value={typeof setting.value === "string" ? setting.value : undefined} disabled={setting.loading} onValueChange={(next) => void setting.change(next as PageSettings[K])}>
          <SelectTrigger id={id} aria-describedby={describedBy} className="h-8 w-auto min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    />
  );
}

/** A typed value: saved on Enter or when the field is left, never on each keystroke. */
function DraftInput({
  id,
  describedBy,
  saved,
  disabled,
  type,
  className,
  placeholder,
  onCommit,
}: {
  id: string;
  describedBy?: string;
  saved: string;
  disabled: boolean;
  type: "text" | "number" | "time";
  className?: string;
  placeholder?: string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    if (text !== saved) onCommit(text);
  };
  return (
    <Input
      id={id}
      aria-describedby={describedBy}
      type={type}
      disabled={disabled}
      placeholder={placeholder}
      className={cn("h-8", className)}
      value={draft ?? saved}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}

export function NumberSetting({ port, name, label, hint, unit }: RowText & { port: PageSettingsPort; name: KeysOf<number>; unit?: string }) {
  const setting = useSetting(port, name);
  const [invalid, setInvalid] = useState(false);
  return (
    <SettingRow
      label={label}
      hint={hint}
      note={setting.loading ? tx("Loading…") : setting.note}
      problem={invalid ? tx("Enter a whole number.") : setting.problem}
      control={({ id, describedBy }) => (
        <>
          <DraftInput
            id={id}
            describedBy={describedBy}
            type="number"
            className="w-20"
            disabled={setting.loading}
            saved={typeof setting.value === "number" ? String(setting.value) : ""}
            onCommit={(text) => {
              const number = Number(text);
              const whole = text.trim() !== "" && Number.isInteger(number);
              setInvalid(!whole);
              if (whole) void setting.change(number as never);
            }}
          />
          {unit !== undefined ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
        </>
      )}
    />
  );
}

export function TextSetting({
  port,
  name,
  label,
  hint,
  type = "text",
  placeholder,
  wide,
}: RowText & { port: PageSettingsPort; name: KeysOf<string>; type?: "text" | "time"; placeholder?: string; wide?: boolean }) {
  const setting = useSetting(port, name);
  return (
    <SettingRow
      label={label}
      hint={hint}
      note={setting.loading ? tx("Loading…") : setting.note}
      problem={setting.problem}
      control={({ id, describedBy }) => (
        <DraftInput
          id={id}
          describedBy={describedBy}
          type={type}
          placeholder={placeholder}
          className={wide === true ? "w-64" : "w-40"}
          disabled={setting.loading}
          saved={typeof setting.value === "string" ? setting.value : ""}
          onCommit={(text) => void setting.change(text as never)}
        />
      )}
    />
  );
}

/** A setting the page shows and never changes: its state, and the way to BB's own settings. */
export function ReadOnlySetting({ label, hint, on, onOpenBbSettings }: RowText & { on: boolean | null; onOpenBbSettings?: () => void }) {
  return (
    <SettingRow
      label={label}
      hint={hint}
      control={({ id }) => (
        <>
          <span id={id} className="text-sm text-foreground">
            {on === null ? tx("Loading…") : on ? tx("On") : tx("Off")}
          </span>
          {onOpenBbSettings !== undefined ? (
            <Button variant="outline" size="sm" className="h-7" onClick={onOpenBbSettings}>
              {tx("Change in BB settings")}
            </Button>
          ) : null}
        </>
      )}
    />
  );
}
