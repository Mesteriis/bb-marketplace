import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";

/** Leaves room for the wrapper the host adds around stdout. */
export const CLI_BUDGET = Math.floor(PLUGIN_CLI_OUTPUT_MAX_BYTES * 0.9);

/** Keep human CLI output under the host's byte cap and say so when cut. */
export function truncateForCli(text: string, budget = CLI_BUDGET): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= budget) return text;
  const notice = `\n\n… truncated: ${bytes.byteLength} bytes of output exceeds the ${budget}-byte CLI limit. Narrow the request (one --skill at a time) or use the RPC/panel for the full text.`;
  const room = budget - Buffer.byteLength(notice, "utf8");
  return `${bytes.subarray(0, Math.max(0, room)).toString("utf8")}${notice}`;
}

export interface ParsedArgv {
  command: string | undefined;
  flags: Record<string, string[]>;
  bare: string[];
}

export function parseArgv(argv: string[]): ParsedArgv {
  const flags: Record<string, string[]> = {};
  const bare: string[] = [];
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
      const next = argv[index + 1];
      let value = inline;
      if (value === undefined && next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      }
      (flags[name] ??= []).push(value ?? "");
      continue;
    }
    if (command === undefined) command = token;
    else bare.push(token);
  }
  return { command, flags, bare };
}

export const flag = (parsed: ParsedArgv, name: string): string | undefined =>
  parsed.flags[name]?.[0];

export const hasFlag = (parsed: ParsedArgv, name: string): boolean =>
  parsed.flags[name] !== undefined;

export interface CliResponse {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

function jsonWithinBudget(
  value: unknown,
  budget: number,
  fallback: Record<string, string>,
): string {
  const candidates = [value, fallback, { error: "CLI request failed." }, {}];
  for (const candidate of candidates) {
    const output = JSON.stringify(candidate, null, 2);
    if (Buffer.byteLength(output, "utf8") <= budget) return output;
  }
  // The real host budget is much larger than this final valid JSON fallback;
  // retaining parseability is more important than preserving an error detail.
  return "{}";
}

/** Format a command result without ever truncating JSON. */
export function formatCliReply(
  value: unknown,
  text: string,
  json: boolean,
  budget = CLI_BUDGET,
): CliResponse {
  if (!json) return { exitCode: 0, stdout: truncateForCli(text, budget) };
  const serialized = JSON.stringify(value, null, 2) ?? "null";
  if (Buffer.byteLength(serialized, "utf8") <= budget) {
    return { exitCode: 0, stdout: serialized };
  }
  return {
    exitCode: 1,
    stdout: jsonWithinBudget(
      {
        error:
          "JSON output exceeds the CLI limit. Narrow the request, for example to one --skill at a time.",
      },
      budget,
      { error: "JSON output too large; narrow the request." },
    ),
  };
}

/** Format command errors as parseable JSON when the caller requested JSON. */
export function formatCliFailure(
  message: string,
  json: boolean,
  budget = CLI_BUDGET,
): CliResponse {
  if (!json) return { exitCode: 1, stderr: truncateForCli(message, budget) };
  return {
    exitCode: 1,
    stdout: jsonWithinBudget({ error: message }, budget, {
      error: "Command failed; narrow the request.",
    }),
  };
}
