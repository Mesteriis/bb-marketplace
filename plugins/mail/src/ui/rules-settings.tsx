// Mail settings -> Rules (slice 3g, #82). The master switch (mailRules) is a
// BB plugin setting, off by default; with it off, only the switch shows.
// Rules are listed with their mode and project; Pause all turns every rule
// off and can be undone.
import { useCallback, useEffect, useState } from "react";
import type { RuleInput, RuleView } from "../core/contract.ts";
import { Button } from "@/components/ui/button";
import { errorText, projectName, useProjects, type BbCall } from "./bb-ports.ts";
import { RuleForm } from "./rule-form.tsx";
import { tx } from "./i18n/index.ts";

export interface RulesSettingsProps {
  /** mailRules as BB has it. */
  on: boolean;
  call: BbCall;
  /** A toast with an optional action (Undo). */
  notify: (text: string, action?: { label: string; run: () => void }) => void;
  /** Where the switch lives. */
  hint: string;
}

export function RulesSettings({ on, call, notify, hint }: RulesSettingsProps) {
  return (
    <div className="flex flex-col gap-3">
      <section aria-label={tx("Mail rules switch")} className="flex flex-col gap-1">
        <p className="text-sm text-foreground">
          {on ? tx("On: your rules run on new Inbox mail.") : tx("Off: no rule runs.")}
        </p>
        <p className="text-xs text-muted-foreground">
          {tx("Rules prepare agent threads from new Inbox mail for you to review, or start them if you chose that for a rule. Threads a rule starts have no mail tools.")} {hint}
        </p>
      </section>
      {on ? <RuleList call={call} notify={notify} /> : null}
    </div>
  );
}

function RuleList({ call, notify }: Pick<RulesSettingsProps, "call" | "notify">) {
  const { projects } = useProjects(call);
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [editing, setEditing] = useState<RuleView | "new" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRules((await call("rules_list", {})).rules);
    } catch (error) {
      setRules([]);
      setProblem(errorText(error, "The rules could not be loaded"));
    }
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (input: RuleInput) => {
    await call("rule_save", input);
    setEditing(null);
    await load();
  };
  const remove = async (rule: RuleView) => {
    try {
      await call("rule_delete", { id: rule.id });
      await load();
    } catch (error) {
      setProblem(errorText(error, "The rule could not be deleted"));
    }
  };
  const pauseAll = async () => {
    try {
      const { paused } = await call("rules_pause", {});
      await load();
      notify(paused === 1 ? "Paused 1 rule" : `Paused ${paused} rules`, {
        label: "Undo",
        run: () => {
          call("rules_pause", { undo: true }).then(load, (error: unknown) => setProblem(errorText(error, "Could not undo")));
        },
      });
    } catch (error) {
      setProblem(errorText(error, "The rules could not be paused"));
    }
  };

  return (
    <section aria-label={tx("Rules")} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tx("Rules")}</h3>
        <Button variant="ghost" size="sm" className="h-7 px-2" disabled={rules === null || !rules.some((r) => r.enabled)} onClick={() => void pauseAll()}>
          {tx("Pause all")}
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-2" disabled={editing !== null} onClick={() => setEditing("new")}>
          {tx("New rule")}
        </Button>
      </div>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {editing !== null ? (
        <RuleForm rule={editing === "new" ? null : editing} projects={projects} onSave={save} onCancel={() => setEditing(null)} />
      ) : null}
      {rules === null ? null : rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tx("No rules yet.")}</p>
      ) : (
        <ul aria-label={tx("Mail rules")} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground">{rule.name}</span>
              <span className="text-xs text-muted-foreground">
                {`${rule.mode === "start" ? "Starts" : "Prepares"} in ${rule.projectName ?? projectName(projects, rule.projectId)}`}
              </span>
              {!rule.enabled ? <span className="text-xs text-muted-foreground">{tx("Off")}</span> : null}
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={editing !== null} onClick={() => setEditing(rule)}>
                {tx("Edit")}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void remove(rule)}>
                {tx("Delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
