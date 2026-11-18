// "Labels..." (slice 3h, #79, `l`): a checklist of the Gmail account's labels
// with a filter and New label.... A label every chosen message has is checked,
// one some have is mixed; Apply sends only what the owner changed. System
// labels never show and a new name is checked against the same rule the
// server uses (core/labels.ts).
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isSystemLabel, validLabelName, type LabelNameRefusal } from "../core/labels.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { msg, tx } from "./i18n/index.ts";

export const LABEL_REFUSAL_TEXT: Record<LabelNameRefusal, string> = {
  empty: msg("Type a name"),
  too_long: msg("Use at most 100 characters"),
  control: msg("The name has characters a label cannot hold"),
  system: msg("That name is one of Gmail's own labels"),
};

export interface LabelsRequest {
  /** How many messages the change touches, for the title. */
  count: number;
  /** Each chosen message's labels, as the store has them. */
  current: readonly (readonly string[])[];
}

type Choice = "on" | "off" | "mixed";

/** The checklist's start: on when every message has the label, mixed when some do. */
export function initialChoices(names: readonly string[], current: readonly (readonly string[])[]): Map<string, Choice> {
  const choices = new Map<string, Choice>();
  for (const name of names) {
    const having = current.filter((labels) => labels.includes(name)).length;
    choices.set(name, having === 0 ? "off" : having === current.length ? "on" : "mixed");
  }
  return choices;
}

/** What Apply sends: labels turned on (add) and turned off (remove); mixed ones untouched. */
export function labelChanges(
  start: ReadonlyMap<string, Choice>,
  now: ReadonlyMap<string, Choice>,
): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const [name, choice] of now) {
    const before = start.get(name) ?? "off";
    if (choice === before || choice === "mixed") continue;
    if (choice === "on") add.push(name);
    else remove.push(name);
  }
  return { add, remove };
}

export function LabelsDialog({
  request,
  labels,
  loadError = null,
  onApply,
  onCancel,
}: {
  request: LabelsRequest | null;
  /** The account's labels (labels_list); null while they load. */
  labels: readonly { name: string; path: string | null }[] | null;
  loadError?: string | null;
  /** Resolves when the server took the change; a refusal rejects with the text to show. */
  onApply: (change: { add: string[]; remove: string[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const open = request !== null;
  const names = useMemo(() => {
    const own = (labels ?? []).map((l) => l.name).filter((name) => !isSystemLabel(name));
    const fromMessages = (request?.current ?? []).flat().filter((name) => !isSystemLabel(name));
    return [...new Set([...own, ...fromMessages])].sort((a, b) => a.localeCompare(b));
  }, [labels, request]);
  const start = useMemo(() => initialChoices(names, request?.current ?? []), [names, request]);
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const [added, setAdded] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [newName, setNewName] = useState("");
  const [naming, setNaming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChoices(new Map());
    setAdded([]);
    setFilter("");
    setNewName("");
    setNaming(false);
    setProblem(null);
    setBusy(false);
  }, [open, request]);

  const all = [...names, ...added.filter((name) => !names.includes(name))];
  const choiceOf = (name: string): Choice => choices.get(name) ?? start.get(name) ?? "off";
  const shown = all.filter((name) => name.toLowerCase().includes(filter.trim().toLowerCase()));

  const toggle = (name: string) => {
    setChoices((prev) => new Map(prev).set(name, choiceOf(name) === "on" ? "off" : "on"));
  };

  const addLabel = (event: FormEvent) => {
    event.preventDefault();
    const checked = validLabelName(newName);
    if (!checked.ok) {
      setProblem(tx(LABEL_REFUSAL_TEXT[checked.reason]));
      return;
    }
    const existing = all.find((name) => name.toLowerCase() === checked.name.toLowerCase());
    const name = existing ?? checked.name;
    if (existing === undefined) setAdded((prev) => [...prev, name]);
    setChoices((prev) => new Map(prev).set(name, "on"));
    setNewName("");
    setNaming(false);
    setProblem(null);
  };

  const apply = async () => {
    const now = new Map(all.map((name) => [name, choiceOf(name)] as const));
    const change = labelChanges(start, now);
    if (change.add.length + change.remove.length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onApply(change);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>{tx("Labels")}</DialogTitle>
          <DialogDescription>
            {request === null || request.count === 1 ? tx("Labels of this conversation's messages in Gmail") : `Labels of ${request.count} messages in Gmail`}
          </DialogDescription>
        </DialogHeader>
        {loadError !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        ) : labels === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {tx("Loading labels\u2026")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              aria-label={tx("Filter labels")}
              placeholder={tx("Filter")}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="h-8"
            />
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">{all.length === 0 ? tx("No labels yet.") : tx("No label matches.")}</p>
            ) : (
              <ul aria-label={tx("Labels")} className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {shown.map((name) => {
                  const choice = choiceOf(name);
                  return (
                    <li key={name} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        aria-label={name}
                        checked={choice === "mixed" ? "indeterminate" : choice === "on"}
                        onClick={() => toggle(name)}
                      />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {naming ? (
              <form onSubmit={addLabel} className="flex items-center gap-1">
                <Input
                  aria-label={tx("New label name")}
                  autoFocus
                  value={newName}
                  maxLength={120}
                  onChange={(event) => setNewName(event.target.value)}
                  className="h-8"
                />
                <Button type="submit" variant="outline" size="sm">
                  {tx("Add")}
                </Button>
              </form>
            ) : (
              <div>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setNaming(true)}>
                  {tx("New label\u2026")}
                </Button>
              </div>
            )}
          </div>
        )}
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {tx("Cancel")}
          </Button>
          <Button onClick={() => void apply()} disabled={busy || labels === null}>
            {busy ? tx("Applying\u2026") : tx("Apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
