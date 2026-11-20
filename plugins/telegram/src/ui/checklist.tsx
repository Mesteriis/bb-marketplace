import { useTelegramLocale } from "./i18n/index.tsx";
import { CopyTelegramLink, type MessageLinkLoader } from "./copy-telegram-link.tsx";
import { Check, Circle } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { checklistEdit, type Checklist, type ChecklistChange, type ChecklistEdit } from "../core/contract.ts";
import { MessageText } from "./message-text.tsx";

export const SetChecklistTask = createContext<((chatId: string, messageId: string, taskId: number, expected: boolean, done: boolean) =>
  Promise<ChecklistChange>) | undefined>(undefined);
export const AddChecklistTask = createContext<((chatId: string, messageId: string, task: string, expected: number[]) =>
  Promise<ChecklistChange>) | undefined>(undefined);

export const EditChecklist = createContext<((chatId: string, messageId: string, expected: string, draft: ChecklistEdit) =>
  Promise<ChecklistChange>) | undefined>(undefined);

export function MessageChecklist({ chatId, messageId, checklist, actionable, highlightedTask, loadLink }: {
  chatId: string;
  messageId: string;
  checklist: Checklist;
  actionable: boolean;
  highlightedTask?: number;
  loadLink?: MessageLinkLoader;
}) {
  const { t: tr } = useTelegramLocale();
  const setTask = useContext(SetChecklistTask);
  const addTask = useContext(AddChecklistTask);
  const editChecklist = useContext(EditChecklist);
  const [pending, setPending] = useState(false);
  const [adding, setAdding] = useState<number[]>();
  const [editing, setEditing] = useState<{ revision: string; draft: ChecklistEdit; completion: Map<number, boolean> }>();
  const [newTask, setNewTask] = useState("");
  const [status, setStatus] = useState("");
  const [confirmed, setConfirmed] = useState<{ before: Checklist; view: Checklist }>();
  const current = confirmed?.before === checklist ? confirmed.view : checklist;
  const doneCount = current.tasks.filter(({ done }) => done).length;
  const parsedEdit = editing && checklistEdit.safeParse(editing.draft);

  async function change(operation: () => Promise<ChecklistChange>) {
    if (pending || !actionable) return false;
    setPending(true);
    setStatus("");
    try {
      const result = await operation();
      if (result.state === "updated") {
        setConfirmed({ before: checklist, view: result.checklist });
        return true;
      }
      if (result.state === "changed") setStatus("This checklist changed in Telegram. Refresh the chat and try again.");
      else setStatus(result.state === "unavailable"
        ? "Could not update this checklist. Check your Premium access, permissions and Telegram’s checklist limits."
        : "Telegram did not confirm the checklist change. Refresh the chat before retrying.");
    } catch {
      setStatus("Could not verify the checklist change.");
    } finally {
      setPending(false);
    }
    return false;
  }

  function moveTask(index: number, by: -1 | 1) {
    if (!editing) return;
    const tasks = [...editing.draft.tasks];
    const target = index + by;
    if (target < 0 || target >= tasks.length || !tasks[index]) return;
    [tasks[index], tasks[target]] = [tasks[target]!, tasks[index]!];
    setEditing({ ...editing, draft: { ...editing.draft, tasks } });
  }

  return <section className="mtg-checklist" aria-label={tr("Checklist")}>
    <div className="mtg-checklist-title"><MessageText {...current.title} /></div>
    <p>{doneCount}{tr(" of ")}{current.tasks.length}{tr(" complete")}</p>
    <ul>
      {current.tasks.map((task, index) => <li key={task.id}
        aria-current={task.id === highlightedTask ? "location" : undefined} tabIndex={task.id === highlightedTask ? -1 : undefined}>
        {setTask && actionable && current.canToggle
          ? <input type="checkbox" checked={task.done} disabled={pending || !!editing}
            aria-label={tr("Task {0} complete", [index + 1])} onChange={() => void change(() => setTask(chatId, messageId, task.id, task.done, !task.done))} />
          : task.done ? <Check size={16} role="img" aria-label={tr("Completed")} /> : <Circle size={16} role="img" aria-label={tr("Open")} />}
        <MessageText {...task.label} />
        {loadLink && <CopyTelegramLink chatId={chatId} messageId={messageId} load={loadLink}
          target={{ kind: "checklist task", id: task.id }} itemLabel={task.label.text} />}
      </li>)}
    </ul>
    {actionable && current.canAdd && addTask && !editing && (adding ? <form onSubmit={async (event) => {
      event.preventDefault();
      const task = newTask.trim();
      if (task && await change(() => addTask(chatId, messageId, task, adding))) {
        setAdding(undefined);
        setNewTask("");
      }
    }}>
      <label>{tr("New task ")}<input autoFocus value={newTask} maxLength={1024} disabled={pending}
        onChange={(event) => setNewTask(event.target.value)} /></label>
      <button type="submit" className="mtg-action" disabled={pending || !newTask.trim()}>{tr("Save task")}</button>
      <button type="button" className="mtg-action" disabled={pending} onClick={() => {
        setAdding(undefined);
        setNewTask("");
        setStatus("");
      }}>{tr("Cancel")}</button>
    </form> : <button type="button" className="mtg-action" disabled={pending}
      onClick={() => setAdding(current.tasks.map(({ id }) => id))}>{tr("Add checklist task")}</button>)}
    {actionable && editChecklist && !adding && (editing ? <form onSubmit={async (event) => {
      event.preventDefault();
      if (parsedEdit?.success && await change(() => editChecklist(chatId, messageId, editing.revision, parsedEdit.data))) setEditing(undefined);
    }}>
      <fieldset disabled={pending}>
        <legend>{tr("Edit checklist")}</legend>
        <label>{tr("Checklist title ")}<input autoFocus maxLength={1024} value={editing.draft.title}
          onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, title: event.target.value } })} /></label>
        {editing.draft.tasks.map(({ id, text }, index) => <div key={id} className="mtg-checklist-edit-task">
          <label>{tr("Task ")}{index + 1} <input maxLength={1024} value={text} onChange={(event) => {
            const value = event.target.value;
            setEditing({ ...editing, draft: { ...editing.draft,
              tasks: editing.draft.tasks.map((task) => task.id === id ? { id, text: value } : task),
            } });
          }} /></label>
          <button type="button" className="mtg-action" aria-label={tr("Move task {0} up", [index + 1])} disabled={index === 0}
            onClick={() => moveTask(index, -1)}>↑</button>
          <button type="button" className="mtg-action" aria-label={tr("Move task {0} down", [index + 1])} disabled={index + 1 === editing.draft.tasks.length}
            onClick={() => moveTask(index, 1)}>↓</button>
          <button type="button" className="mtg-action" aria-label={tr("Remove task {0}", [index + 1])} disabled={editing.draft.tasks.length === 1}
            onClick={() => setEditing({ ...editing, draft: {
              ...editing.draft, tasks: editing.draft.tasks.filter((task) => task.id !== id),
              removed: [...(editing.draft.removed ?? []), { id, done: editing.completion.get(id) === true }],
            } })}>{tr("Remove")}</button>
        </div>)}
        <label><input type="checkbox" checked={editing.draft.othersCanAdd}
          onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, othersCanAdd: event.target.checked } })} />{tr("Let others add tasks")}</label>
        <label><input type="checkbox" checked={editing.draft.othersCanComplete}
          onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, othersCanComplete: event.target.checked } })} />{tr("Let others mark tasks complete")}</label>
        <button type="submit" className="mtg-action" disabled={!parsedEdit?.success}>{tr("Save checklist changes")}</button>
        <button type="button" className="mtg-action" onClick={() => { setEditing(undefined); setStatus(""); }}>{tr("Cancel edit")}</button>
      </fieldset>
    </form> : current.editRevision && <button type="button" className="mtg-action" disabled={pending} onClick={() => {
      if (!current.editRevision) return;
      setEditing({ revision: current.editRevision, completion: new Map(current.tasks.map(({ id, done }) => [id, done])), draft: {
        title: current.title.text, tasks: current.tasks.map(({ id, label }) => ({ id, text: label.text })),
        othersCanAdd: current.othersCanAdd === true, othersCanComplete: current.othersCanComplete === true,
      } });
    }}>{tr("Edit checklist")}</button>)}
    {status && <p role="status">{tr(status)}</p>}
  </section>;
}
