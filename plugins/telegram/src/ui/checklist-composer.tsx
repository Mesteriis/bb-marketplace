import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import { checklistDraft, type ChecklistAvailability, type ChecklistDraft } from "../core/contract.ts";

export function ChecklistComposer({ load, disabled, scheduled, send }: {
  load: () => Promise<ChecklistAvailability>;
  disabled: boolean;
  scheduled: boolean;
  send: (draft: ChecklistDraft) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [available, setAvailable] = useState<ChecklistAvailability>();
  const [title, setTitle] = useState("");
  const nextId = useRef(2);
  const [tasks, setTasks] = useState([{ id: 1, text: "" }]);
  const [othersCanAdd, setOthersCanAdd] = useState(false);
  const [othersCanComplete, setOthersCanComplete] = useState(false);

  useEffect(() => {
    let active = true;
    void load().then((result) => { if (active) setAvailable(result); },
      () => { if (active) setAvailable({ state: "unavailable" }); });
    return () => { active = false; };
  }, [load]);

  if (!available) return <p role="status">{tr("Checking checklist availability…")}</p>;
  if (available.state !== "ready") return <p role="status">{available.state === "premium_required"
    ? tr("Telegram Premium is required to send checklists.") : tr("Checklists are unavailable in this conversation.")}</p>;
  const { limits } = available;
  const parsed = checklistDraft.safeParse({ title, tasks: tasks.map(({ text }) => text), othersCanAdd, othersCanComplete });
  const valid = parsed.success && parsed.data.title.length <= limits.title && parsed.data.tasks.length <= limits.count
    && parsed.data.tasks.every((task) => task.length <= limits.task);
  return <fieldset aria-label={tr("Checklist draft")} disabled={disabled}>
    <label>{tr("Checklist title ")}<input autoFocus value={title} maxLength={limits.title} onChange={(event) => setTitle(event.target.value)} /></label>
    <ol>
      {tasks.map(({ id, text }, index) => <li key={id}>
        <label>{tr("Task ")}{index + 1} <input value={text} maxLength={limits.task} onChange={(event) => {
          setTasks((previous) => previous.map((task) => task.id === id ? { id, text: event.target.value } : task));
        }} /></label>
        <button type="button" className="mtg-action" aria-label={tr("Remove task {0}", [index + 1])} disabled={tasks.length <= 1}
          onClick={() => setTasks((previous) => previous.filter((task) => task.id !== id))}>{tr("Remove")}</button>
      </li>)}
    </ol>
    <button type="button" className="mtg-action" disabled={tasks.length >= limits.count} onClick={() => {
      const id = nextId.current++;
      setTasks((previous) => [...previous, { id, text: "" }]);
    }}>{tr("Add task")}</button>
    <label><input type="checkbox" checked={othersCanAdd} onChange={(event) => setOthersCanAdd(event.currentTarget.checked)} />{tr("Let others add tasks")}</label>
    <label><input type="checkbox" checked={othersCanComplete} onChange={(event) => setOthersCanComplete(event.currentTarget.checked)} />{tr("Let others mark tasks complete")}</label>
    <button type="button" className="mtg-action" disabled={!valid}
      onClick={() => { if (valid) send(parsed.data); }}>{scheduled ? tr("Schedule checklist") : tr("Send checklist")}</button>
  </fieldset>;
}
