import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Entry } from "../core/model.ts";
import { nameOf, type Problem } from "./model.ts";
import { Modal } from "./dialogs.tsx";
import { ProblemLine } from "./pane.tsx";
import { batchRenameText, ru } from "./strings.ts";
import { previewRename, type RenamePattern, type RenameProblem } from "../core/rename-pattern.ts";
import type { NameSegment } from "../core/path.ts";
import "./batch-rename.css";

interface Form {
  template: string;
  find: string;
  regex: boolean;
  replace: string;
  caseMode: "keep" | "lower" | "upper" | "title";
  start: string;
  step: string;
  width: string;
}

const initialForm: Form = {
  template: "[N].[E]", find: "", regex: false, replace: "",
  caseMode: "keep", start: "1", step: "1", width: "3",
};

/** The pattern the form describes. Blank or out-of-range counter fields fall back to the defaults. */
export function patternFrom(form: Form): RenamePattern {
  const number = (text: string, fallback: number) => {
    const value = Number.parseInt(text, 10);
    return Number.isFinite(value) ? value : fallback;
  };
  const pattern: RenamePattern = {
    case: form.caseMode,
    counter: {
      start: Math.max(0, number(form.start, 1)),
      step: Math.max(1, number(form.step, 1)),
      width: Math.min(12, Math.max(1, number(form.width, 1))),
    },
  };
  if (form.template.trim() !== "") pattern.template = form.template;
  if (form.find !== "") {
    pattern.find = form.regex ? { regex: form.find } : { text: form.find };
    pattern.replace = form.replace;
  }
  return pattern;
}

function problemText(problem: RenameProblem): string {
  return batchRenameText.problems[problem];
}

function sameText(a: NameSegment, b: NameSegment): boolean {
  return "t" in a && "t" in b && a.t === b.t;
}

/**
 * Batch rename of the selected entries: a name pattern, a find and replace, a case
 * mode and a counter. The preview is computed here, from the listing already on
 * screen; the plan is checked again on the host when it is created.
 */
export function BatchRenameDialog({ entries, directory, caseSensitive, busy, error, submit, close }: {
  entries: Entry[];
  directory: Entry[];
  caseSensitive: boolean;
  busy: boolean;
  error: Problem | null;
  submit: (pattern: RenamePattern) => void;
  close: () => void;
}) {
  const [form, setForm] = useState<Form>(initialForm);
  const pattern = useMemo(() => patternFrom(form), [form]);
  const rows = useMemo(() => previewRename(entries, pattern, { directory, caseSensitive }), [entries, pattern, directory, caseSensitive]);
  const changed = rows.filter((row) => row.to !== null && !sameText(row.from, row.to));
  const conflicts = rows.filter((row) => row.problem !== null).length;
  const canSubmit = !busy && changed.length > 0 && conflicts === 0;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));

  return <Modal title={batchRenameText.title} description={batchRenameText.description} close={close} busy={busy}>
    <form className="cm-dialog-form cm-batch-rename" onSubmit={(event) => { event.preventDefault(); if (canSubmit) submit(pattern); }}>
      <label>{batchRenameText.template}
        <Input value={form.template} maxLength={1024} onChange={(event) => set("template", event.currentTarget.value)} />
      </label>
      <p className="cm-batch-rename-hint">{batchRenameText.templateHint}</p>
      <div className="cm-batch-rename-row">
        <label>{batchRenameText.find}
          <Input value={form.find} maxLength={512} onChange={(event) => set("find", event.currentTarget.value)} />
        </label>
        <label>{batchRenameText.replace}
          <Input value={form.replace} maxLength={512} onChange={(event) => set("replace", event.currentTarget.value)} />
        </label>
        <label className="cm-batch-rename-check">
          <input type="checkbox" checked={form.regex} onChange={(event) => set("regex", event.currentTarget.checked)} />
          {batchRenameText.regex}
        </label>
      </div>
      <div className="cm-batch-rename-row">
        <label>{batchRenameText.counterStart}
          <Input inputMode="numeric" value={form.start} onChange={(event) => set("start", event.currentTarget.value)} />
        </label>
        <label>{batchRenameText.counterStep}
          <Input inputMode="numeric" value={form.step} onChange={(event) => set("step", event.currentTarget.value)} />
        </label>
        <label>{batchRenameText.counterWidth}
          <Input inputMode="numeric" value={form.width} onChange={(event) => set("width", event.currentTarget.value)} />
        </label>
        <label>{batchRenameText.caseMode}
          <select value={form.caseMode} onChange={(event) => set("caseMode", event.currentTarget.value as Form["caseMode"])}>
            <option value="keep">{batchRenameText.caseKeep}</option>
            <option value="lower">{batchRenameText.caseLower}</option>
            <option value="upper">{batchRenameText.caseUpper}</option>
            <option value="title">{batchRenameText.caseTitle}</option>
          </select>
        </label>
      </div>
      <div className="cm-batch-rename-preview" role="region" aria-label={batchRenameText.preview}>
        <table>
          <thead><tr><th scope="col">{batchRenameText.from}</th><th scope="col">{batchRenameText.to}</th><th scope="col">{batchRenameText.state}</th></tr></thead>
          <tbody>
            {rows.map((row, index) => <tr key={index} data-problem={row.problem ?? "none"}>
              <td>{nameOf(row.from)}</td>
              <td>{row.to ? nameOf(row.to) : "—"}</td>
              <td>{row.problem ? problemText(row.problem) : batchRenameText.ok}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className="cm-batch-rename-summary" aria-live="polite">
        {batchRenameText.summary(changed.length, conflicts)}
      </p>
      {error && <ProblemLine problem={error} />}
      <div className="cm-actions">
        <Button type="submit" size="sm" disabled={!canSubmit}>{batchRenameText.makePlan}</Button>
        <Button type="button" size="sm" variant="outline" onClick={close}>{ru.cancel}</Button>
      </div>
    </form>
  </Modal>;
}
