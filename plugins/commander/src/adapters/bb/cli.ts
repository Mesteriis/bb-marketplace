import { cliCommand, defineCli, PluginCliError, PLUGIN_CLI_OUTPUT_MAX_BYTES, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { parsePosix } from "../../core/path.ts";
import { rpcSchemas } from "../../core/wire/rpc.ts";
import { jobView, publicError, type Operations } from "./rpc-handlers.ts";

const owner = { kind: "owner" } as const;
const endpoint = { name: "endpoint", description: "Endpoint ID", required: true } as const;
const path = { name: "path", description: "Absolute resource path", required: true } as const;
const jobId = { name: "id", description: "Job ID", required: true } as const;
const signal = (value?: AbortSignal) => value ?? new AbortController().signal;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new PluginCliError("Invalid Commander arguments", { code: "invalid" });
  return result.data;
}

async function show(action: () => Promise<unknown>) {
  try {
    const stdout = JSON.stringify(await action()) + "\n";
    if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
      throw new PluginCliError("Commander result exceeds the CLI output limit", { code: "limit_exceeded" });
    }
    return { exitCode: 0, stdout };
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    const safe = publicError(error);
    throw new PluginCliError(safe.message, { code: safe.code });
  }
}

function ref(endpoint: string, path: string) {
  return { endpoint, path: parsePosix(path) };
}

function transfer(ops: Operations, kind: "copy" | "move") {
  return cliCommand({
    summary: "Plan a file or directory " + kind,
    positionals: [endpoint, path,
      { name: "destination", description: "Destination endpoint ID", required: true },
      { name: "directory", description: "Absolute destination directory", required: true }],
    run: ({ positionals: args }, ctx) => show(() => ops.createPlan(parse(rpcSchemas.plan_create.input, {
      kind, sources: [ref(args.endpoint, args.path)], targetDir: ref(args.destination, args.directory),
      newName: null, conflictPolicy: "ask", verify: "size",
    }), owner, signal(ctx.signal))),
  });
}

export function registerCli(cli: BbPluginApi["cli"], ops: Operations) {
  cli.register(defineCli({
    name: "makosh-commander",
    summary: "Browse file endpoints and manage file operation jobs",
    commands: {
      endpoints: cliCommand({
        summary: "List file endpoints",
        run: (_, ctx) => show(() => ops.endpointsList(owner, signal(ctx.signal))),
      }),
      ls: cliCommand({
        summary: "List directory metadata",
        positionals: [endpoint, path],
        options: {
          cursor: { type: "string", description: "Cursor from the preceding page" },
          limit: { type: "integer", min: 1, max: 1000, default: 100, description: "Maximum number of entries" },
        },
        run: ({ positionals: args, options }, ctx) => show(() => ops.list(parse(rpcSchemas.dir_list.input, {
          ref: ref(args.endpoint, args.path), cursor: options.cursor, limit: options.limit,
        }), owner, signal(ctx.signal))),
      }),
      "plan copy": transfer(ops, "copy"),
      "plan move": transfer(ops, "move"),
      "plan delete": cliCommand({
        summary: "Plan removal of a file or directory",
        positionals: [endpoint, path],
        run: ({ positionals: args }, ctx) => show(() => ops.createPlan(parse(rpcSchemas.plan_create.input, {
          kind: "delete", sources: [ref(args.endpoint, args.path)], targetDir: null,
          newName: null, conflictPolicy: "ask", verify: "size",
        }), owner, signal(ctx.signal))),
      }),
      run: cliCommand({
        summary: "Submit a saved owner plan",
        positionals: [
          { name: "planId", description: "Saved plan ID", required: true },
          { name: "digest", description: "Saved SHA-256 digest", required: true },
        ],
        run: ({ positionals }, ctx) => show(() => ops.runPlan(parse(rpcSchemas.plan_run.input, positionals), owner, signal(ctx.signal))),
      }),
      jobs: cliCommand({
        summary: "List file operation jobs",
        options: { limit: { type: "integer", min: 1, max: 200, default: 100, description: "Maximum number of jobs" } },
        run: ({ options }) => show(async () => ({ jobs: (await ops.jobs({ limit: options.limit })).map(jobView) })),
      }),
      cancel: cliCommand({
        summary: "Cancel a file operation job",
        positionals: [jobId],
        run: ({ positionals }) => show(() => ops.cancel(parse(rpcSchemas.job_cancel.input, { jobId: positionals.id }).jobId, owner)),
      }),
    },
  }));
}
