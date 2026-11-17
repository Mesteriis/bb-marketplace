// The conversation's BB project (slice 3g, #81): a chip that binds the
// conversation to one project, a suggestion from its dev links (never bound
// by itself) with Accept, and "Always for ..." binding rules. Also the native
// project picker the BB dialogs share.
import { useId, useState } from "react";
import type { ProjectListItem } from "../core/contract.ts";
import type { ThreadDetail } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { BB_TEXT, FIELD_CLASS } from "./bb-ports.ts";
import { tx } from "./i18n/index.ts";

export interface ProjectSelectProps {
  label: string;
  projects: readonly ProjectListItem[] | null;
  value: string | null;
  onChange: (projectId: string) => void;
  /** Projects without a single local checkout cannot be picked. */
  requireTree?: boolean;
  disabled?: boolean;
}

/** A labelled native select of BB projects. */
export function ProjectSelect({ label, projects, value, onChange, requireTree = false, disabled }: ProjectSelectProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        className={cn(FIELD_CLASS, "h-8")}
        value={value ?? ""}
        disabled={disabled === true || projects === null}
        onChange={(event) => {
          if (event.target.value !== "") onChange(event.target.value);
        }}
      >
        <option value="" disabled>
          {projects === null ? tx("Loading projects\u2026") : projects.length === 0 ? tx("No projects in BB") : tx("Choose a project")}
        </option>
        {(projects ?? []).map((project) => (
          <option key={project.id} value={project.id} disabled={requireTree && !project.hasTree}>
            {requireTree && !project.hasTree ? `${project.name} (no local checkout)` : project.name}
          </option>
        ))}
      </select>
      {requireTree && value !== null && projects?.find((p) => p.id === value)?.hasTree === false ? (
        <p className="text-xs text-muted-foreground">{BB_TEXT.no_tree}</p>
      ) : null}
    </div>
  );
}

/** A binding rule the chip can offer for the conversation's latest message. */
export type AlwaysChoice = { kind: "address" | "domain" | "list" | "repo"; value: string };

/** "Always for ..." choices: the sender, the sender's domain, and the suggestion's repository. */
export function alwaysChoices(detail: ThreadDetail): AlwaysChoice[] {
  const latest = detail.messages.at(-1);
  const choices: AlwaysChoice[] = [];
  const address = latest?.from.address.trim().toLowerCase() ?? "";
  if (address.includes("@")) {
    choices.push({ kind: "address", value: address });
    const domain = address.slice(address.lastIndexOf("@") + 1);
    if (domain !== "") choices.push({ kind: "domain", value: domain });
  }
  const repo = detail.projectSuggestion?.repo ?? latest?.dev?.repo ?? null;
  if (repo !== null && repo !== "") choices.push({ kind: "repo", value: repo });
  return choices;
}

export interface ProjectChipProps {
  detail: ThreadDetail;
  projects: readonly ProjectListItem[] | null;
  /** Binds the conversation (null: unbinds). */
  onSet: (projectId: string | null) => void;
  /** Adds a binding rule and binds the conversation. */
  onAlways: (choice: AlwaysChoice, projectId: string) => void;
  onOpenProject: (projectId: string) => void;
}

export function ProjectChip({ detail, projects, onSet, onAlways, onOpenProject }: ProjectChipProps) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(detail.project?.id ?? null);
  // Older servers answer without these fields.
  const project = detail.project ?? null;
  const suggestion = project === null ? (detail.projectSuggestion ?? null) : null;
  const target = picked ?? suggestion?.id ?? null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <Icon name="Folder" className="size-3.5" aria-hidden />
        <span>{tx("Project:")}</span>
        {project !== null ? (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-foreground" onClick={() => onOpenProject(project.id)}>
            {project.name}
          </Button>
        ) : suggestion !== null ? (
          <>
            <span className="rounded-sm border border-dashed border-border px-1 text-foreground">{`${suggestion.name}?`}</span>
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => onSet(suggestion.id)}>
              {tx("Accept")}
            </Button>
          </>
        ) : (
          <span>{"\u2014"}</span>
        )}
        {project?.source === "rule" ? <span>{tx("(by a binding rule)")}</span> : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {tx("Change")}
        </Button>
      </div>
      {open ? (
        <div role="group" aria-label={tx("Conversation project")} className="flex flex-col gap-2 rounded-md border border-border p-2">
          <ProjectSelect label={tx("Project")} projects={projects} value={target} onChange={setPicked} />
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              className="h-7 px-2"
              disabled={target === null}
              onClick={() => {
                if (target === null) return;
                onSet(target);
                setOpen(false);
              }}
            >
              {tx("Bind this conversation")}
            </Button>
            {target !== null
              ? alwaysChoices(detail).map((choice) => (
                  <Button
                    key={`${choice.kind}:${choice.value}`}
                    variant="outline"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => {
                      onAlways(choice, target);
                      setOpen(false);
                    }}
                  >
                    {`Always for ${choice.value}`}
                  </Button>
                ))
              : null}
            {project?.source === "owner" ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => {
                  onSet(null);
                  setOpen(false);
                }}
              >
                {tx("Unbind")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
