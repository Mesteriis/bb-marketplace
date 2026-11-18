// One mail rule (slice 3g, #82): what new Inbox mail it matches, the BB
// project and the instruction, and the mode. Prepare (the default) only
// queues a thread for the owner to review; Start begins one by itself, so
// it needs a project with a local checkout and an explicit confirmation
// that names the risk.
import { useId, useState } from "react";
import type { ProjectListItem, RuleInput, RuleView } from "../core/contract.ts";
import { DEV_KINDS, DEV_SOURCES, DEV_STATES } from "../core/dev-notify.ts";
import { RULE_CAPS, validateRule } from "../core/mail-rules.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BB_TEXT, FIELD_CLASS } from "./bb-ports.ts";
import { ProjectSelect } from "./project-chip.tsx";
import { tx } from "./i18n/index.ts";

/** The fixed lines of the Start confirmation. */
export function startConfirmText(projectName: string): string {
  return tx("An email from anyone matching this rule will start an agent in {projectName}", { projectName });
}
export const START_MODE_LINE = "Runs with accept-edits permissions in a new worktree";
export const CAPS_LINE = `At most ${RULE_CAPS.perRuleHour} threads an hour and ${RULE_CAPS.perRuleDay} a day for a rule, ${RULE_CAPS.allDay} a day for all rules, one a day per conversation.`;

const split = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");

export interface RuleFormProps {
  /** The rule to edit; null: a new one. */
  rule: RuleView | null;
  projects: readonly ProjectListItem[] | null;
  onSave: (input: RuleInput) => Promise<void>;
  onCancel: () => void;
}

export function RuleForm({ rule, projects, onSave, onCancel }: RuleFormProps) {
  const ids = { name: useId(), from: useId(), domains: useId(), list: useId(), words: useId(), repo: useId(), source: useId(), kind: useId(), state: useId(), template: useId() };
  const match = rule?.match ?? {};
  const [name, setName] = useState(rule?.name ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [from, setFrom] = useState((match.from ?? []).join(", "));
  const [domains, setDomains] = useState((match.domains ?? []).join(", "));
  const [list, setList] = useState(match.list ?? "");
  const [words, setWords] = useState((match.subjectWords ?? []).join(" "));
  const [source, setSource] = useState<string>(match.dev?.source ?? "");
  const [kind, setKind] = useState<string>(match.dev?.kind ?? "");
  const [state, setState] = useState<string>(match.dev?.state ?? "");
  const [repo, setRepo] = useState(match.dev?.repo ?? "");
  const [projectId, setProjectId] = useState<string | null>(rule?.projectId ?? null);
  const [template, setTemplate] = useState(rule?.template ?? "");
  const [mode, setMode] = useState<"prepare" | "start">(rule?.mode ?? "prepare");
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const project = projects?.find((p) => p.id === projectId) ?? null;
  const startAllowed = project === null || project.hasTree;

  const input = (): RuleInput => {
    const dev = {
      ...(source !== "" ? { source: source as (typeof DEV_SOURCES)[number] } : {}),
      ...(kind !== "" ? { kind: kind as (typeof DEV_KINDS)[number] } : {}),
      ...(state !== "" ? { state: state as (typeof DEV_STATES)[number] } : {}),
      ...(repo.trim() !== "" ? { repo: repo.trim() } : {}),
    };
    return {
      ...(rule !== null ? { id: rule.id } : {}),
      name: name.trim(),
      enabled,
      match: {
        from: split(from),
        domains: split(domains).map((d) => d.toLowerCase()),
        list: list.trim() === "" ? null : list.trim().toLowerCase(),
        subjectWords: split(words),
        dev: Object.keys(dev).length > 0 ? dev : null,
      },
      projectId: projectId ?? "",
      template,
      mode,
      ...(mode === "start" ? { confirmedStart: confirmed } : {}),
    };
  };
  const save = async () => {
    const next = input();
    const checked = validateRule({ ...next, match: { ...next.match, dev: next.match.dev ?? null } });
    if (!checked.ok) {
      setProblem(checked.reason);
      return;
    }
    if (mode === "start" && !startAllowed) {
      setProblem(tx(BB_TEXT.no_tree));
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await onSave(next);
    } catch (error) {
      setProblem(tx(error instanceof Error && error.message !== "" ? error.message : "The rule could not be saved"));
    } finally {
      setSaving(false);
    }
  };

  const field = (id: string, label: string, value: string, onChange: (v: string) => void, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint !== undefined ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
  const select = (id: string, label: string, value: string, onChange: (v: string) => void, options: readonly string[]) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <select id={id} className={cn(FIELD_CLASS, "h-8")} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{tx("Any")}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <form
      aria-label={rule === null ? tx("New rule") : tx("Edit {name}", { name: rule.name })}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {field(ids.name, "Name", name, setName)}
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} />
        {tx("On")}
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-semibold text-foreground">{tx("When new Inbox mail matches all of")}</legend>
        {field(ids.from, "From addresses", from, setFrom, "Separated by commas")}
        {field(ids.domains, "Sender domains", domains, setDomains)}
        {field(ids.list, "Mailing list id", list, setList)}
        {field(ids.words, "Subject words", words, setWords, "Whole words, any case")}
        <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
          {select(ids.source, "Notification from", source, setSource, DEV_SOURCES)}
          {select(ids.kind, "Kind", kind, setKind, DEV_KINDS)}
          {select(ids.state, "State", state, setState, DEV_STATES)}
          {field(ids.repo, "Repository", repo, setRepo)}
        </div>
      </fieldset>
      <ProjectSelect label={tx("In project")} projects={projects} value={projectId} onChange={setProjectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.template} className="text-xs font-medium text-muted-foreground">
          {tx("Instruction for the agent")}
        </label>
        <textarea
          id={ids.template}
          rows={3}
          maxLength={4000}
          className={cn(FIELD_CLASS, "resize-y py-2")}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-semibold text-foreground">{tx("Then")}</legend>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="radio" name="rule-mode" checked={mode === "prepare"} onChange={() => setMode("prepare")} />
          {tx("Prepare a thread for me to review")}
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="radio"
            name="rule-mode"
            checked={mode === "start"}
            disabled={!startAllowed}
            onChange={() => {
              setMode("start");
              setConfirmed(false);
            }}
          />
          {tx("Start the thread by itself")}
        </label>
        {!startAllowed ? <p className="text-xs text-muted-foreground">{tx(BB_TEXT.no_tree)}</p> : null}
        {mode === "start" ? (
          <div role="group" aria-label={tx("Start confirmation")} className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm">
            <p>{startConfirmText(project?.name ?? "the project")}</p>
            <p className="text-xs text-muted-foreground">{START_MODE_LINE}</p>
            <label className="flex items-center gap-2">
              <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} />
              {tx("I understand")}
            </label>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">{CAPS_LINE}</p>
      </fieldset>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {tx("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={saving || (mode === "start" && !confirmed)}>
          {tx("Save rule")}
        </Button>
      </div>
    </form>
  );
}
