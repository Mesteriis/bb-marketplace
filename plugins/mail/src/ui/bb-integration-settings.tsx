// Mail settings -> BB integration (slice 3g): the folders saved attachments
// and patches go to, where Make a task puts tasks, whether dev mail is
// recognised, and the binding rules. The values are BB plugin settings,
// shown here read-only with where to change them; an invalid folder says
// why (the server then uses the default).
import { useCallback, useEffect, useState } from "react";
import type { BindingView } from "../core/contract.ts";
import { PROJECT_PATH_REFUSAL_TEXT, projectFolder } from "../core/project-paths.ts";
import { Button } from "@/components/ui/button";
import { errorText, type BbCall } from "./bb-ports.ts";
import { msg, tx } from "./i18n/index.ts";

export interface BbSettingsValues {
  attachmentFolder: string;
  patchFolder: string;
  taskTarget: "auto" | "taskboard" | "local";
  devNotifications: boolean;
}

/** Why a folder setting is not used, or null when it is fine. */
export function folderProblem(folder: string): string | null {
  const checked = projectFolder(folder);
  return checked.ok ? null : PROJECT_PATH_REFUSAL_TEXT[checked.reason];
}

const TARGET_TEXT: Record<BbSettingsValues["taskTarget"], string> = {
  auto: msg("Taskboard when it answers, else Mail's own Tasks"),
  taskboard: msg("Taskboard"),
  local: msg("Mail's own Tasks"),
};

const KIND_TEXT: Record<BindingView["kind"], string> = { address: msg("Sender"), domain: msg("Domain"), list: msg("List"), repo: msg("Repository") };

export interface BbIntegrationSettingsProps {
  values: BbSettingsValues;
  call: BbCall;
  /** Where the plugin settings live. */
  hint: string;
}

export function BbIntegrationSettings({ values, call, hint }: BbIntegrationSettingsProps) {
  const folders: [string, string, string][] = [
    ["Attachments saved to a project go to", values.attachmentFolder, "mail-attachments"],
    ["Patches saved to a project go to", values.patchFolder, "mail-patches"],
  ];
  return (
    <div className="flex flex-col gap-4">
      <section aria-label={tx("Folders")} className="flex flex-col gap-1">
        {folders.map(([label, value, fallback]) => {
          const problem = folderProblem(value);
          return (
            <div key={label} className="flex flex-col">
              <p className="text-sm text-foreground">{`${label} ${value}/`}</p>
              {problem !== null ? <p role="alert" className="text-xs text-destructive">{`${problem}; ${fallback}/ is used instead.`}</p> : null}
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          {tx("Inside the project's own folder. Mail writes only new files there, never into .git or a folder that starts with a dot, and never opens or runs them.")}
        </p>
      </section>
      <section aria-label={tx("Tasks")} className="flex flex-col gap-1">
        <p className="text-sm text-foreground">{tx("Make a task puts tasks in: {p1}", { p1: TARGET_TEXT[values.taskTarget] })}</p>
      </section>
      <section aria-label={tx("Dev notifications")} className="flex flex-col gap-1">
        <p className="text-sm text-foreground">
          {values.devNotifications
            ? tx("Dev notifications: on. GitHub, GitLab, CI and monitoring mail is recognised on this computer.")
            : tx("Dev notifications: off.")}
        </p>
      </section>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Bindings call={call} />
    </div>
  );
}

function Bindings({ call }: { call: BbCall }) {
  const [bindings, setBindings] = useState<BindingView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setBindings((await call("bindings_list", {})).bindings);
    } catch (error) {
      setBindings([]);
      setProblem(errorText(error, "The binding rules could not be loaded"));
    }
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);
  const remove = async (binding: BindingView) => {
    try {
      await call("binding_remove", { kind: binding.kind, value: binding.value });
      await load();
    } catch (error) {
      setProblem(errorText(error, "The rule could not be removed"));
    }
  };
  return (
    <section aria-label={tx("Project binding rules")} className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-foreground">{tx("Project binding rules")}</h3>
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      {bindings === null ? null : bindings.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tx("None. Always for a sender in a conversation's Project chip adds one.")}</p>
      ) : (
        <ul aria-label={tx("Binding rules")} className="flex flex-col gap-1">
          {bindings.map((binding) => (
            <li key={`${binding.kind}:${binding.value}`} className="flex items-center gap-2 text-sm">
              <span className="text-xs text-muted-foreground">{KIND_TEXT[binding.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{binding.value}</span>
              <span className="text-xs text-muted-foreground">
                {binding.removed ? tx("project removed") : (binding.projectName ?? binding.projectId)}
              </span>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void remove(binding)}>
                {tx("Remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
