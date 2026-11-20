// AI sorts the inbox: the switch and the owner's AI labels (Mail settings →
// AI features → Sorting). A label is a name and, in the owner's words,
// what belongs under it; it can archive automatically.
import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tx } from "../i18n/index.ts";
import { SettingsGroup } from "./primitives.tsx";
import { Switch, SwitchSetting, type PageSettingsPort } from "./setting-controls.tsx";
import { messageOf } from "./shared.ts";

export interface AiLabelView {
  id: string;
  name: string;
  description: string;
  autoArchive: boolean;
}

export interface AiLabelPorts {
  list: () => Promise<AiLabelView[]>;
  save: (input: { id?: string; name: string; description: string; autoArchive: boolean }) => Promise<AiLabelView>;
  remove: (id: string) => Promise<void>;
  /** The labels in their new order. */
  move: (id: string, direction: -1 | 1) => Promise<AiLabelView[]>;
}

export const LABEL_NAME_MAX = 30;
export const LABEL_DESCRIPTION_MAX = 300;

type Draft = { id: string | null; name: string; description: string; autoArchive: boolean };
const EMPTY: Draft = { id: null, name: "", description: "", autoArchive: false };

export function SortingSettings({ port, labels: ports }: { port: PageSettingsPort; labels: AiLabelPorts }) {
  const formId = useId();
  const [labels, setLabels] = useState<AiLabelView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { list } = ports;
  useEffect(() => {
    let live = true;
    list().then(
      (found) => {
        if (live) setLabels(found);
      },
      (error) => {
        if (live) {
          setLabels([]);
          setProblem(messageOf(error, "The labels could not be loaded"));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [list]);

  const run = async (work: () => Promise<void>, failed: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(messageOf(error, failed));
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (draft === null) return;
    void run(async () => {
      const saved = await ports.save({
        ...(draft.id !== null ? { id: draft.id } : {}),
        name: draft.name,
        description: draft.description,
        autoArchive: draft.autoArchive,
      });
      setLabels((prev) => {
        const known = prev ?? [];
        return known.some((label) => label.id === saved.id) ? known.map((label) => (label.id === saved.id ? saved : label)) : [...known, saved];
      });
      setDraft(null);
    }, "The label could not be saved");
  };
  const remove = (id: string) =>
    void run(async () => {
      await ports.remove(id);
      setLabels((prev) => (prev ?? []).filter((label) => label.id !== id));
    }, "The label could not be removed");
  const move = (id: string, direction: -1 | 1) =>
    void run(async () => {
      setLabels(await ports.move(id, direction));
    }, "The label could not be saved");
  const ready = draft !== null && draft.name.trim() !== "" && draft.description.trim() !== "";

  return (
    <SettingsGroup title={tx("Sorting")}>
      <div className="flex flex-col">
        <SwitchSetting
          port={port}
          name="aiSort"
          label={tx("Sort new mail with AI")}
          hint={tx("One line and your own AI labels for every new Inbox message; a label can archive automatically. Uses your AI provider; at most 100 calls a day.")}
        />
      </div>
      {labels !== null && labels.length === 0 && draft === null ? (
        <p className="text-xs text-muted-foreground">{tx("No AI labels yet. A label is a name and, in your own words, what belongs under it.")}</p>
      ) : null}
      {labels !== null && labels.length > 0 ? (
        <ul aria-label={tx("AI labels")} className="flex flex-col">
          {labels.map((label, index) => (
            <li key={label.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border py-2 first:border-t-0">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {label.name}
                  {label.autoArchive ? <span className="ml-2 text-xs font-normal text-muted-foreground">{tx("archives automatically")}</span> : null}
                </span>
                <span className="break-words text-xs text-muted-foreground">{label.description}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy || index === 0} aria-label={`${tx("Move up")}: ${label.name}`} onClick={() => move(label.id, -1)}>
                  {"↑"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={busy || index === labels.length - 1}
                  aria-label={`${tx("Move down")}: ${label.name}`}
                  onClick={() => move(label.id, 1)}
                >
                  {"↓"}
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy} aria-label={`${tx("Edit")}: ${label.name}`} onClick={() => setDraft({ ...label })}>
                  {tx("Edit")}
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy} aria-label={`${tx("Remove")}: ${label.name}`} onClick={() => remove(label.id)}>
                  {tx("Remove")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {draft !== null ? (
        <form onSubmit={save} className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${formId}-name`} className="text-xs text-muted-foreground">
              {tx("Label name")}
            </label>
            <Input id={`${formId}-name`} autoFocus value={draft.name} maxLength={LABEL_NAME_MAX} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${formId}-description`} className="text-xs text-muted-foreground">
              {tx("What belongs under it")}
            </label>
            <Input
              id={`${formId}-description`}
              value={draft.description}
              maxLength={LABEL_DESCRIPTION_MAX}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </div>
          <div className="flex items-start gap-2">
            <Switch id={`${formId}-archive`} checked={draft.autoArchive} describedBy={`${formId}-archive-hint`} onChange={(next) => setDraft({ ...draft, autoArchive: next })} />
            <div className="flex min-w-0 flex-col">
              <label htmlFor={`${formId}-archive`} className="text-sm text-foreground">
                {tx("Archive automatically")}
              </label>
              <span id={`${formId}-archive-hint`} className="text-xs text-muted-foreground">
                {tx("New mail that gets this label leaves the Inbox for Archive. Mail from people you write to, flagged mail and mail with a sender warning always stays.")}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={!ready || busy}>
              {tx("Save label")}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
              {tx("Cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="outline" size="sm" disabled={labels === null || busy} onClick={() => setDraft(EMPTY)}>
            {tx("Add label")}
          </Button>
        </div>
      )}
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {tx(problem)}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
