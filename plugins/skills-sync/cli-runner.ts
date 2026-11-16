import type { PluginCliRegistration } from "@get-bb/plugin-sdk";
import type { Source } from "./contract";
import {
  flag,
  formatCliFailure,
  formatCliReply,
  hasFlag,
  parseArgv,
} from "./cli-utils";
import { renderStatus } from "./status-render";
import type { ParsedSources } from "./source-config";
import { diffSkill, statusFrom, type ApplyResult, type Prepared } from "./sync";

export interface CliRunnerDependencies {
  sources: Source[];
  parsed: ParsedSources;
  load: (sourceId: string, refresh: boolean) => Promise<Prepared>;
  apply: (
    sourceId: string,
    names: string[],
    bumpMarker: boolean,
    allowConflictOverwrite: boolean,
  ) => Promise<ApplyResult>;
}

const usage = [
  "Usage:",
  "  bb skills-sync sources [--json]",
  "  bb skills-sync status [--source <id>] [--refresh] [--json]",
  "  bb skills-sync diff --skill <name> [--kind upstream|local] [--source <id>] [--json]",
  "  bb skills-sync apply --skill <name> [--skill <name>...] [--bump] [--overwrite-edits] [--source <id>] [--json]",
  "",
  "Buckets: new, clean (safe to overwrite), dirty-conflict (needs a hand merge),",
  "dirty-only (your edit stands), deprecated. Folders with no upstream match are",
  "listed as foreign and are never modified, deleted, or offered.",
  "",
  "apply acts only on the names you pass. It never globs the install folder, and",
  "it writes the pin marker last, only with --bump and only if every name lands",
  "and no upstream work remains unresolved.",
  "--overwrite-edits is destructive: it explicitly allows a skill with local edits",
  "to be replaced by upstream HEAD and should only be used when dropping those edits.",
].join("\n");

const registration = {
  name: "skills-sync",
  summary: "Compare installed agent skills against their upstream git repos and update them",
  commands: [
    {
      name: "sources",
      summary: "List the configured upstream skill repositories",
      usage: "bb skills-sync sources [--json]",
    },
    {
      name: "status",
      summary:
        "Bucket every skill as new, clean, dirty-conflict, dirty-only or deprecated, separating real upstream changes from punctuation-only churn",
      usage: "bb skills-sync status [--source <id>] [--refresh] [--json]",
    },
    {
      name: "diff",
      summary:
        "Show the unified diff for one skill: --kind upstream is pin..HEAD, --kind local is pin..installed",
      usage:
        "bb skills-sync diff --skill <name> [--kind upstream|local] [--source <id>] [--json]",
    },
    {
      name: "apply",
      summary:
        "Install or overwrite named skills; --overwrite-edits explicitly discards local edits, while --bump writes the pin marker only when every name lands and no work is unresolved",
      usage:
        "bb skills-sync apply --skill <name> [--skill <name>...] [--bump] [--overwrite-edits] [--source <id>] [--json]",
    },
  ],
} satisfies Omit<PluginCliRegistration, "run">;

export function createCliRunner(
  dependencies: CliRunnerDependencies,
): PluginCliRegistration {
  return {
    ...registration,
    async run(argv) {
      const args = parseArgv(argv);
      const json = hasFlag(args, "json");
      const reply = (value: unknown, text: string) =>
        formatCliReply(value, text, json);
      const fail = (message: string) => formatCliFailure(message, json);

      const defaultSourceId = () =>
        flag(args, "source") ?? dependencies.sources[0]?.id ?? "";

      try {
        switch (args.command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };

          case "sources": {
            if (dependencies.sources.length === 0) {
              return fail(
                dependencies.parsed.ok
                  ? "No sources configured."
                  : dependencies.parsed.message,
              );
            }
            return reply(
              { sources: dependencies.sources },
              dependencies.sources
                .map(
                  (source) =>
                    `${source.id}\n  url         ${source.url} (${source.ref})\n` +
                    `  skills      ${source.skillsDir}${source.nested ? "/<bucket>" : ""}/<name>\n` +
                    `  skip        ${source.skipBuckets.join(", ") || "(none)"}\n` +
                    `  installRoot ${source.installRoot}\n  marker      ${source.marker}`,
                )
                .join("\n\n"),
            );
          }

          case "status": {
            const status = statusFrom(
              await dependencies.load(
                defaultSourceId(),
                hasFlag(args, "refresh"),
              ),
            );
            return reply(status, renderStatus(status));
          }

          case "diff": {
            const name = flag(args, "skill");
            if (name === undefined || name === "") {
              return fail("diff needs --skill <name>.\n\n" + usage);
            }
            const kind = flag(args, "kind") ?? "upstream";
            if (kind !== "upstream" && kind !== "local") {
              return fail(`--kind must be "upstream" or "local", got "${kind}".`);
            }
            const patch = await dependencies.load(defaultSourceId(), false).then(
              (prepared) => diffSkill(prepared, name, kind),
            );
            return reply(
              { name, kind, patch },
              patch === "" ? `No ${kind} difference for "${name}".` : patch,
            );
          }

          case "apply": {
            const names = (args.flags.skill ?? []).filter((name) => name !== "");
            if (names.length === 0) {
              return fail(
                "apply needs at least one --skill <name>. It never globs the install folder.\n\n" +
                  usage,
              );
            }
            const result = await dependencies.apply(
              defaultSourceId(),
              names,
              hasFlag(args, "bump"),
              hasFlag(args, "overwrite-edits"),
            );
            const text = [
              result.applied.length > 0
                ? `Applied: ${result.applied.join(", ")}`
                : "Applied nothing.",
              ...result.failed.map((entry) => `Failed ${entry.name}: ${entry.error}`),
              ...result.backups.map((backup) => `Backup ${backup.name}: ${backup.path}`),
              ...(result.markerRefusal === null
                ? []
                : [`Marker refusal: ${result.markerRefusal}`]),
              result.marker === null
                ? "Marker: not written (no pin)."
                : `Marker: ${result.marker}${hasFlag(args, "bump") && result.failed.length === 0 && result.markerRefusal === null ? " (bumped)" : " (unchanged)"}`,
            ].join("\n");
            const response = reply(result, text);
            if (
              (result.failed.length > 0 || result.markerRefusal !== null) &&
              response.exitCode === 0
            ) {
              return { ...response, exitCode: 1 };
            }
            return response;
          }
        }
        return fail(`Unknown command "${args.command}".\n\n${usage}`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
