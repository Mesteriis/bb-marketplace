import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { businessDayMinutes, businessHours, type BusinessHours, type schemas } from "../core/contract.ts";

type HoursView = z.infer<typeof schemas.businessHours.output>;
type HoursChange = z.input<typeof schemas.saveBusinessHours.input>;
type Boundary = { day: number; time: string };
type Interval = { id: number; start: Boundary; end: Boundary };
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function boundary(minute: number): Boundary {
  const inDay = minute % businessDayMinutes;
  return { day: Math.floor(minute / businessDayMinutes),
    time: `${String(Math.floor(inDay / 60)).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}` };
}

function minute({ day, time }: Boundary) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? day * businessDayMinutes + Number(match[1]) * 60 + Number(match[2]) : NaN;
}

export function BusinessHoursSettings({ read, save }: {
  read: () => Promise<HoursView>;
  save: (input: HoursChange) => Promise<z.infer<typeof schemas.saveBusinessHours.output>>;
}) {
  const { t: tr } = useTelegramLocale();
  const pending = useRef(false);
  const nextIntervalId = useRef(0);
  const [view, setView] = useState<HoursView>();
  const [zone, setZone] = useState("");
  const [draft, setDraft] = useState<Interval[]>([]);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const parsed = businessHours.safeParse({ zone,
    intervals: draft.map(({ start, end }) => ({ startMinute: minute(start), endMinute: minute(end) })),
  });
  const hours: BusinessHours | null | undefined = draft.length ? parsed.data : null;
  const changed = JSON.stringify(hours) !== JSON.stringify(view?.hours);

  async function load() {
    const result = await read();
    setView(result);
    setZone(result?.hours?.zone ?? "");
    setDraft(result?.hours?.intervals.map(({ startMinute, endMinute }) => ({
      id: nextIntervalId.current++, start: boundary(startMinute), end: boundary(endMinute),
    })) ?? []);
    setStale(false);
  }

  async function run(task: () => Promise<void>, failure: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await task(); }
    catch { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!view || stale || hours === undefined || !changed) return;
    void run(async () => {
      const result = await save({ hours, revision: view.revision });
      if (result === "saved") {
        setNotice(hours ? "Business hours saved." : "Business hours removed.");
        setStale(true);
        try { await load(); }
        catch { setError("Could not reload the hours. Reload before editing again."); }
      } else if (result === "changed") {
        setStale(true);
        setError("The hours changed in Telegram. Reload before editing.");
      } else setError("Telegram could not use these Business hours.");
    }, "Could not confirm the Business hours update.");
  }

  function updateBoundary(id: number, field: "start" | "end", value: Boundary) {
    setDraft((previous) => previous.map((row) => row.id === id ? { ...row, [field]: value } : row));
  }

  return <>
    <h3>{tr("Business hours")}</h3>
    <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void run(load, "Could not load Business hours.")}>{view === undefined ? tr("Load hours") : tr("Reload hours")}</button>
    {view === null && <p>{tr("Business hours are unavailable for this account.")}</p>}
    {view && <form onSubmit={submit}>
      <fieldset disabled={busy || stale}>
        <label>{tr("Business time zone ")}<select value={zone} onChange={(event) => setZone(event.target.value)}>
          <option value="">{tr("Choose a time zone")}</option>
          {view.hours?.zone && !view.zones.some(({ id }) => id === view.hours?.zone)
            && <option value={view.hours.zone}>{view.hours.zone}</option>}
          {view.zones.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        {draft.map(({ id, start, end }, index) => <fieldset key={id}>
          <legend>{tr("Opening period ")}{index + 1}</legend>
          <BusinessHoursBoundary label={tr("Opens")} value={start} change={(value) => updateBoundary(id, "start", value)} />
          <BusinessHoursBoundary label={tr("Closes")} value={end} end change={(value) => updateBoundary(id, "end", value)} />
          <button type="button" className="mtg-action" onClick={() => setDraft((previous) => previous.filter((row) => row.id !== id))}>{tr("Remove period ")}{index + 1}
          </button>
        </fieldset>)}
        <button type="button" className="mtg-action" disabled={draft.length >= 28} onClick={() => {
          const id = nextIntervalId.current++;
          setDraft((previous) => [...previous, { id, start: { day: 0, time: "09:00" }, end: { day: 0, time: "17:00" } }]);
        }}>{tr("Add opening period")}</button>
        {!!draft.length && <button type="button" className="mtg-action" onClick={() => setDraft([])}>{tr("Clear all periods")}</button>}
      </fieldset>
      {draft.length > 0 && hours === undefined && <p role="alert">{tr("Choose a time zone and make each closing time later than its opening time.")}</p>}
      {view.hours && hours === null && <p>{tr("The published hours will be removed when you save.")}</p>}
      <button type="submit" className="mtg-action" disabled={busy || stale || hours === undefined || !changed}>{tr("Save hours")}</button>
    </form>}
    {busy && <p role="status">{tr("Updating Business hours…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
  </>;
}

function BusinessHoursBoundary({ label, value, end, change }: {
  label: string; value: Boundary; end?: boolean; change: (value: Boundary) => void;
}) {
  const { t: tr } = useTelegramLocale();
  return <>
    <label>{label}{tr(" day ")}<select value={value.day} onChange={(event) => {
      const day = Number(event.target.value);
      change({ day, time: day === (end ? 8 : 7) ? "00:00" : value.time });
    }}>
      {days.map((day, index) => <option key={day} value={index}>{day}</option>)}
      <option value={7}>{tr("Next Monday")}</option>
      {end && <option value={8}>{tr("Next Tuesday at midnight")}</option>}
    </select></label>
    <label>{label}{tr(" time ")}<input type="time" disabled={value.day === (end ? 8 : 7)} value={value.time}
      onChange={(event) => change({ ...value, time: event.target.value })} /></label>
  </>;
}
