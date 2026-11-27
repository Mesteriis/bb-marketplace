import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { ciAction, type CiAction } from "../../core/ci/actions.ts";
import { dispatchValues } from "../../core/ci/dispatch.ts";
import type { DispatchSpec } from "../../core/ci/dispatch.ts";
import type { Job, Run, RunFilter } from "../../core/ci/model.ts";
import type { Workflow } from "../../core/ci/pipelines.ts";
import { elapsed } from "../../core/ci/summary.ts";
import type { CiOperation } from "../../core/ci/capabilities.ts";

/** The part of the CI service the CLI uses. */
type CiReads = {
  runs(copyId: string, filter: RunFilter, page: number): Promise<{items: Run[]; more: boolean;
    operations: Record<CiOperation, boolean>; limitations: Record<string, string>}>;
  run(copyId: string, runId: string): Promise<{run: Run; jobs: Job[]}>;
  workflows(copyId: string): Promise<{workflows: Workflow[]; defaultBranch: string | null}>;
  form(copyId: string, workflowId: string, ref: string): Promise<DispatchSpec>;
  prepare(copyId: string, action: CiAction): Promise<{id: string; lines: string[]}>;
  confirm(previewId: string): Promise<unknown>;
};
export type CiCliDeps = {
  /** The thread's attached copy and the agent access the owner gave it. */
  context(threadId: string): Promise<{copyId: string; permission: "none" | "read" | "write"}>;
  service: CiReads;
  now?: () => number;
  /** Asks the owner in the thread; true only when they approved this very preview. */
  approve(threadId: string, previewId: string, title: string, lines: string[], signal: AbortSignal): Promise<boolean>;
};

export const ciUsage = [
  "Usage (from a BB thread whose working copy is attached in Git):",
  "  bb git-dashboard ci list [--active|--failed] [--page N] [--json]",
  "  bb git-dashboard ci show <run-id> [--json]",
  "  bb git-dashboard ci workflows [--json]",
  "  bb git-dashboard ci run <workflow-id|file|name> [--ref <branch>] [name=value ...]",
  "  bb git-dashboard ci rerun <run-id> [--all]",
  "  bb git-dashboard ci cancel <run-id>",
  "Writes wait for the owner's approval in the thread.",
].join("\n");
/** One BB command entry: its names must be `[a-z0-9-]+`, so the subcommands live in its usage. */
export const ciCommands = [
  {name: "ci", summary: "CI/CD of the thread's working copy: list, show, workflows, run, rerun, cancel (writes after the owner approves)",
    usage: "bb git-dashboard ci <list|show|workflows|run|rerun|cancel> … (bb git-dashboard help)"},
];
const usageOf = {
  show: "bb git-dashboard ci show <run-id> [--json]",
  run: "bb git-dashboard ci run <workflow-id|file|name> [--ref <branch>] [name=value ...]",
  rerun: "bb git-dashboard ci rerun <run-id> [--all]",
  cancel: "bb git-dashboard ci cancel <run-id>",
};

class CliError extends Error {}
const codeOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PROVIDER_UNAVAILABLE";
const fail = (code: string, detail?: string): never => { throw new CliError(detail ? code + " · " + detail : code); };
const writes = new Set(["run", "rerun", "cancel"]);
const titles = {dispatch: "Approve CI: run workflow", rerun: "Approve CI: re-run", cancel: "Approve CI: cancel run"} as const;

/** `bb git-dashboard ci …` for agents and terminals: reads the thread's copy, and writes only after approval. */
export function ciCli(deps: CiCliDeps) {
  return async (argv: string[], ctx: PluginCliContext): Promise<PluginCliResult> => {
    const [group, command, ...rest] = argv;
    if (group === undefined || group === "help" || group === "--help" || group === "-h" || command === "help") return {exitCode: 0, stdout: ciUsage};
    if (group !== "ci") return {exitCode: 1, stderr: ciUsage};
    try {
      const {flags, values, positional} = parse(rest);
      if (!ctx.threadId) fail("THREAD_REQUIRED", "run this from a BB thread whose working copy is attached in Git");
      const {copyId, permission} = await deps.context(ctx.threadId!);
      if (permission === "none" || (writes.has(command ?? "") && permission !== "write")) fail("ACCESS_DENIED");
      const json = flags.has("--json");
      switch (command) {
        case "list": {
          const filter: RunFilter = flags.has("--failed") ? "failed" : flags.has("--active") ? "active" : "all";
          const page = Number(values.get("--page") ?? "1");
          if (!Number.isInteger(page) || page < 1 || page > 50) fail("USAGE", "--page takes 1 to 50");
          const {items, more} = await deps.service.runs(copyId, filter, page);
          if (json) return {exitCode: 0, stdout: JSON.stringify(items)};
          const now = (deps.now ?? Date.now)();
          const lines = items.map(run => [run.state, run.id, run.workflow + " #" + (run.number ?? run.id), "[" + (run.branch ?? "-") + "]",
            elapsed(run, now) ?? "—", run.title].join("  "));
          return {exitCode: 0, stdout: [...lines, ...(more ? ["… more on --page " + (page + 1)] : [])].join("\n") || "No runs."};
        }
        case "show": {
          const [runId] = positional;
          if (!runId) fail("USAGE", usageOf.show);
          const {run, jobs} = await deps.service.run(copyId, runId);
          if (json) return {exitCode: 0, stdout: JSON.stringify({run, jobs})};
          return {exitCode: 0, stdout: [[run.state, run.workflow + " #" + (run.number ?? run.id), "[" + (run.branch ?? "-") + "]", run.title].join("  "),
            ...jobs.map(job => "  " + [job.state, job.id, job.name].join("  "))].join("\n")};
        }
        case "workflows": {
          const {workflows, defaultBranch} = await deps.service.workflows(copyId);
          const ref = defaultBranch ?? "main";
          // A workflow whose file cannot be read (GitHub's dynamic ones, one missing on this branch) keeps its row.
          const detailed: (Workflow & {spec: DispatchSpec | null; error?: string})[] = [];
          for (let index = 0; index < workflows.length; index += 4) {
            detailed.push(...await Promise.all(workflows.slice(index, index + 4).map(workflow => deps.service.form(copyId, workflow.id, ref)
              .then(spec => ({...workflow, spec}), (error: unknown) => ({...workflow, spec: null, error: codeOf(error)})))));
          }
          if (json) return {exitCode: 0, stdout: JSON.stringify({defaultBranch, workflows: detailed})};
          return {exitCode: 0, stdout: ["default branch: " + (defaultBranch ?? "unknown"), ...detailed.flatMap(workflow => [
            [workflow.id, workflow.name, workflow.path ?? "", !workflow.spec ? "[inputs not readable: " + workflow.error + "]"
              : workflow.spec.dispatchable ? "[manual]" : "[no manual trigger]"].filter(Boolean).join("  "),
            ...(workflow.spec?.inputs ?? []).map(input => "    " + input.name + ": " + input.type + (input.required ? " (required)" : "") +
              (input.default !== null ? " = " + input.default : "") + (input.options.length ? " [" + input.options.join("|") + "]" : "")),
          ])].join("\n")};
        }
        case "run": {
          const [selector, ...pairs] = positional;
          if (!selector) fail("USAGE", usageOf.run);
          const {workflows, defaultBranch} = await deps.service.workflows(copyId);
          const needle = selector.toLowerCase();
          const workflow = workflows.find(item => item.id === selector) ?? workflows.find(item => item.path !== null &&
            (item.path.toLowerCase() === needle || item.path.toLowerCase().endsWith("/" + needle))) ?? workflows.find(item => item.name.toLowerCase() === needle);
          if (!workflow) return fail("NOT_FOUND", "no workflow " + selector + "; see bb git-dashboard ci workflows");
          const ref = values.get("--ref") ?? defaultBranch;
          if (!ref) fail("USAGE", "--ref is needed: the repository has no default branch");
          const given: Record<string, string> = {};
          for (const pair of pairs) {
            const at = pair.indexOf("=");
            if (at <= 0) fail("USAGE", "expected name=value, got " + pair);
            given[pair.slice(0, at)] = pair.slice(at + 1);
          }
          const spec = await deps.service.form(copyId, workflow.id, ref!);
          if (!spec.dispatchable) fail("NOT_DISPATCHABLE", workflow.name + " has no manual trigger");
          const unknown = Object.keys(given).filter(name => !spec.inputs.some(input => input.name === name));
          if (unknown.length) fail("UNKNOWN_INPUT", unknown.join(", "));
          const missing = spec.inputs.filter(input => input.required && !(given[input.name] ?? input.default ?? "").trim()).map(input => input.name);
          if (missing.length) fail("INPUT_REQUIRED", missing.join(", "));
          // An input left out takes its declared default, as the Run workflow form fills it in.
          const defaults = Object.fromEntries(spec.inputs.flatMap(input => input.default !== null ? [[input.name, input.default]] : []));
          return await write(copyId, {kind: "dispatch", workflowId: workflow.id, ref: ref!, inputs: dispatchValues(spec, {...defaults, ...given})}, ctx);
        }
        case "rerun":
        case "cancel": {
          const [runId] = positional;
          if (!runId) fail("USAGE", usageOf[command]);
          return await write(copyId, command === "rerun" ? {kind: "rerun", runId, failedOnly: !flags.has("--all")} : {kind: "cancel", runId}, ctx);
        }
      }
      return {exitCode: 1, stderr: ciUsage};
    } catch (error) {
      const code = error instanceof CliError ? error.message : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PROVIDER_UNAVAILABLE";
      return {exitCode: 1, stderr: code};
    }
  };

  async function write(copyId: string, input: CiAction, ctx: PluginCliContext): Promise<PluginCliResult> {
    const action = ciAction.parse(input);
    // What the forge or the token cannot do is refused before the owner is asked, as the panel hides it.
    const {operations, limitations} = await deps.service.runs(copyId, "all", 1);
    const operation: CiOperation = action.kind === "dispatch" ? (Object.keys(action.inputs).length ? "dispatchInputs" : "dispatch")
      : action.kind === "cancel" ? "cancel" : action.failedOnly ? "rerunFailed" : "rerunAll";
    for (const needed of action.kind === "dispatch" && operation === "dispatchInputs" ? ["dispatch", "dispatchInputs"] as const : [operation]) {
      if (!operations[needed]) fail("PROVIDER_UNSUPPORTED", limitations[needed] ?? "the forge does not offer this");
    }
    const preview = await deps.service.prepare(copyId, action);
    const signal = ctx.signal ?? new AbortController().signal;
    if (!await deps.approve(ctx.threadId!, preview.id, titles[action.kind], preview.lines, signal)) return {exitCode: 1, stderr: "CANCELLED"};
    await deps.service.confirm(preview.id);
    return {exitCode: 0, stdout: "Done: " + preview.lines.join("; ")};
  }
}

/** Flags, `--name value` options and positional words; `name=value` pairs stay positional. */
function parse(args: string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--ref" || arg === "--page") {
      const value = args[++index];
      if (value === undefined) fail("USAGE", arg + " needs a value");
      values.set(arg, value);
    } else if (arg.startsWith("--")) flags.add(arg);
    else positional.push(arg);
  }
  return {flags, values, positional};
}
