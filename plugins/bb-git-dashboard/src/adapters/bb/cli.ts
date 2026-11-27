import { cliCommand, defineCli, type PluginCliContext } from "@get-bb/plugin-sdk";
import type { ciCli } from "./ci-cli.ts";
import type { reviewCommands } from "./code-review-cli.ts";
import { TEXT_MAX_BYTES } from "./code-review-cli.ts";

type Ci = ReturnType<typeof ciCli>;
type Review = ReturnType<typeof reviewCommands>;
const json = {type: "boolean", description: "Print JSON"} as const;
const runId = {name: "run-id", description: "The run's id, as `ci list` prints it", required: true} as const;
const textOption = {type: "string", stdin: true, placeholder: "base64",
  description: `The text as one line of base64, at most ${TEXT_MAX_BYTES} bytes decoded; --text-base64-stdin reads that line from stdin`} as const;

/** `bb git-dashboard`: CI/CD of the thread's working copy, and answers to the line review sent to the thread. */
export function gitDashboardCli(ci: Ci, review: Review) {
  const ciRun = (command: string, ctx: PluginCliContext, flags: string[], values: [string, string | undefined][], positional: string[]) =>
    ci.run(command, {flags: new Set(flags), values: new Map(values.filter((pair): pair is [string, string] => pair[1] !== undefined)), positional}, ctx);
  const flag = (on: boolean, name: string) => on ? [name] : [];
  const answer = (action: "reply" | "resolve" | "dismiss", summary: string, what: string) => cliCommand({
    summary, description: `Run from the BB thread the comments were sent to. The ${what} is the words after the id, or --text-base64.`,
    positionals: [{name: "id", description: "The comment thread's id, or a unique prefix of four or more characters", required: true},
      {name: "text", description: "The " + what, variadic: true}] as const,
    options: {"text-base64": textOption},
    run: (input, ctx) => review.answer(action, input.positionals.id, input.positionals.text, input.options["text-base64"], ctx.threadId),
  });
  return defineCli({
    name: "git-dashboard",
    summary: "Makosh Git: CI/CD of the thread's working copy, and answers to its line review",
    description: "Run from a BB thread whose working copy is attached in Git. CI writes wait for the owner's approval in the thread.",
    commands: {
      "ci list": cliCommand({summary: "Recent CI/CD runs", options: {active: {type: "boolean", description: "Only runs not finished yet"},
        failed: {type: "boolean", description: "Only failed runs"}, page: {type: "integer", min: 1, max: 50, default: 1, description: "Page of 30 runs"}, json},
        constraints: [{kind: "at-most-one", options: ["active", "failed"]}],
        run: (input, ctx) => ciRun("list", ctx, [...flag(input.options.active, "--active"), ...flag(input.options.failed, "--failed"), ...flag(input.options.json, "--json")],
          [["--page", String(input.options.page)]], [])}),
      "ci show": cliCommand({summary: "One run with its jobs", positionals: [runId] as const, options: {json},
        run: (input, ctx) => ciRun("show", ctx, flag(input.options.json, "--json"), [], [input.positionals["run-id"]])}),
      "ci workflows": cliCommand({summary: "Workflows and their manual-run inputs", options: {json},
        run: (input, ctx) => ciRun("workflows", ctx, flag(input.options.json, "--json"), [], [])}),
      "ci run": cliCommand({summary: "Start a workflow by hand, after the owner approves",
        positionals: [{name: "workflow", description: "The workflow's id, file or name", required: true},
          {name: "inputs", description: "Inputs as name=value", variadic: true}] as const,
        options: {ref: {type: "string", description: "Branch or tag; the default branch when left out"}},
        run: (input, ctx) => ciRun("run", ctx, [], [["--ref", input.options.ref]], [input.positionals.workflow, ...input.positionals.inputs])}),
      "ci rerun": cliCommand({summary: "Re-run failed jobs, after the owner approves", positionals: [runId] as const,
        options: {all: {type: "boolean", description: "Re-run every job"}},
        run: (input, ctx) => ciRun("rerun", ctx, flag(input.options.all, "--all"), [], [input.positionals["run-id"]])}),
      "ci cancel": cliCommand({summary: "Cancel a run, after the owner approves", positionals: [runId] as const,
        run: (input, ctx) => ciRun("cancel", ctx, [], [], [input.positionals["run-id"]])}),
      "review list": cliCommand({summary: "The comment threads sent to this thread, with every comment",
        options: {all: {type: "boolean", description: "Include resolved and dismissed threads"}, json},
        run: (input, ctx) => review.list(input.options.all, input.options.json, ctx.threadId)}),
      "review reply": answer("reply", "Answer in a comment thread; it stays open", "reply"),
      "review resolve": answer("resolve", "Resolve a comment thread with a one-line summary of the change", "summary"),
      "review dismiss": answer("dismiss", "Close a comment thread you will not act on, with the reason", "reason"),
    },
  });
}
