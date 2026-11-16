// bb-plugin-skills-sync — the backend.
//
// This file is deliberately thin: it defines the BB settings and surfaces,
// loads the host-independent engine, and composes the one apply path used by
// both RPC and CLI callers.
import * as path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, type Source } from "./contract";
import { DEFAULT_SOURCES, parseSources } from "./source-config";
import { createCliRunner } from "./cli-runner";
import {
  SyncError,
  applySkills,
  diffSkill,
  prepare,
  statusFrom,
} from "./sync";
import {
  acceptMerge,
  assertMergeStagingLocation,
  assertMergeableConflict,
  discardMerge,
  findReadyMergeStageFor,
  listMergeStages,
  mergeDiff,
  mergeStageDir,
  mergeThreadTitle,
  mergeTokenFromThreadTitle,
  newMergeToken,
  watchMergeStage,
  type MergeWatcher,
} from "./sync-merge";

/** Realtime channel app.tsx listens on after a successful apply. */
const SKILLS_APPLIED = "skills-applied";
const AUTO_FETCH_SCHEDULE = "auto-fetch";
const AUTO_FETCH_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

function parseAutoFetchHours(raw: string | undefined):
  | { ok: true; hours: number }
  | { ok: false; message: string } {
  const text = (raw ?? "").trim();
  const validHours = AUTO_FETCH_HOURS.join(", ");
  if (!/^(?:0|[1-9]\d*)$/.test(text)) {
    return {
      ok: false,
      message:
        "The \"autoFetchHours\" setting must be 0 or a whole-hour divisor of 24 " +
        "(one of " + validHours + "); got \"" + (raw ?? "") + "\".",
    };
  }
  const hours = Number(text);
  if (hours !== 0 && !AUTO_FETCH_HOURS.includes(hours as (typeof AUTO_FETCH_HOURS)[number])) {
    return {
      ok: false,
      message:
        "The \"autoFetchHours\" setting must be 0 or a whole-hour divisor of 24 " +
        "(one of " + validHours + "); got \"" + text + "\".",
    };
  }
  return { ok: true, hours };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    sources: {
      type: "string",
      label: "Skill sources (JSON)",
      description:
        "A JSON array of upstream skill repositories. Each entry: id, url, ref, " +
        "skillsDir, nested, skipBuckets, installRoot (absolute), marker.",
      experimental_multiline: true,
      default: DEFAULT_SOURCES,
    },
    autoFetchHours: {
      type: "string",
      label: "Automatic fetch interval (hours)",
      description:
        "0 disables scheduled fetching; otherwise use a whole-hour divisor of 24.",
      default: "6",
    },
    mergeProviderId: {
      type: "string",
      label: "Merge agent provider",
      description: "Provider used for agent-assisted skill merges.",
      default: "codex",
    },
    mergeModel: {
      type: "string",
      label: "Merge agent model",
      description: "Model used for agent-assisted skill merges.",
      default: "gpt-5.6-luna",
    },
    mergeReasoningLevel: {
      type: "select",
      label: "Merge agent reasoning",
      description: "Reasoning level used for agent-assisted skill merges.",
      options: ["low", "medium", "high", "xhigh", "max"],
      default: "high",
    },
  });

  const values = await settings.get();
  const parsed = parseSources(values.sources);
  const sources = parsed.ok ? parsed.sources : [];
  if (!parsed.ok) {
    bb.log.error(parsed.message);
    bb.status.needsConfiguration(parsed.message);
  }

  const autoFetch = parseAutoFetchHours(values.autoFetchHours);
  if (!autoFetch.ok) {
    bb.log.error(autoFetch.message);
    bb.status.needsConfiguration(autoFetch.message);
  }

  /** The plugin's own cache directory. Read lazily: dataDir is bind-gated. */
  function cacheRoot(): string {
    return path.join(bb.server.experimental_dataDir, "plugins", bb.pluginId, "cache");
  }

  function findSource(sourceId: string): Source {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) {
      throw new SyncError(
        sources.length === 0
          ? `No sources are configured. ${parsed.ok ? "" : parsed.message}`.trim()
          : `Unknown source "${sourceId}". Configured: ${sources.map((s) => s.id).join(", ")}.`,
      );
    }
    return source;
  }

  const load = (sourceId: string, refresh: boolean) =>
    prepare(findSource(sourceId), cacheRoot(), refresh);

  type MergeThread = {
    id: string;
    title: string | null;
    status: "active" | "error" | "idle" | "starting" | "stopping";
    createdAt: number;
  };

  async function mergeThreads(source: Source, name: string): Promise<MergeThread[]> {
    const threads = await bb.sdk.threads.list({
      archived: false,
      includeHidden: true,
      limit: 100,
      originPluginId: bb.pluginId,
    });
    return threads
      .filter((thread) => mergeTokenFromThreadTitle(source, name, thread.title) !== null)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        status: thread.status,
        createdAt: thread.createdAt,
      }));
  }

  async function mergeFailureMessage(threadId: string): Promise<string> {
    try {
      const result = await bb.sdk.threads.output({ threadId });
      const output = result.output?.trim();
      if (output !== undefined && output !== null && output !== "") return output;
    } catch {
      // The thread status is still authoritative if its output is unavailable.
    }
    return "The merge thread stopped without producing a staged skill.";
  }

  async function currentMergeState(source: Source, name: string) {
    const stages = listMergeStages(cacheRoot(), source, name);
    for (const stage of stages) {
      assertMergeStagingLocation(cacheRoot(), source.installRoot, stage.dir);
    }
    const threads = await mergeThreads(source, name);
    const byToken = new Map<string, { stage?: (typeof stages)[number]; thread?: MergeThread }>();
    for (const stage of stages) byToken.set(stage.token, { stage });
    for (const thread of threads) {
      const token = mergeTokenFromThreadTitle(source, name, thread.title);
      if (token === null) continue;
      const current = byToken.get(token) ?? {};
      current.thread = thread;
      byToken.set(token, current);
    }
    // The token travels with the state so a watcher can be armed for this
    // attempt alone, rather than for anything staged under the skill.
    const newest = [...byToken.entries()]
      .sort(([, a], [, b]) => {
        const aTime = a.thread?.createdAt ?? a.stage?.modifiedAt ?? 0;
        const bTime = b.thread?.createdAt ?? b.stage?.modifiedAt ?? 0;
        return bTime - aTime;
      })[0];
    if (newest === undefined) {
      return {
        token: null,
        state: "none" as const,
        threadId: null,
        stagingDir: null,
        error: null,
      };
    }
    const [token, candidate] = newest;
    if (candidate.stage?.ready === true) {
      return {
        token,
        state: "ready" as const,
        threadId: candidate.thread?.id ?? null,
        stagingDir: candidate.stage.dir,
        error: null,
      };
    }
    if (candidate.thread?.status === "error") {
      return {
        token,
        state: "failed" as const,
        threadId: candidate.thread.id,
        stagingDir: candidate.stage?.dir ?? null,
        error: await mergeFailureMessage(candidate.thread.id),
      };
    }
    if (candidate.thread !== undefined) {
      return {
        token,
        state: "running" as const,
        threadId: candidate.thread.id,
        stagingDir: candidate.stage?.dir ?? null,
        error: null,
      };
    }
    return {
      token,
      state: "failed" as const,
      threadId: null,
      stagingDir: candidate.stage?.dir ?? null,
      error: "The merge stopped without producing a staged skill.",
    };
  }

  /**
   * End every merge thread for this skill, and report what it could not end.
   *
   * Archiving is what makes the merge disappear from `mergeState`, which reads
   * only unarchived threads. `stopFirst` is for cancel: an archived thread whose
   * agent is still running would keep writing into a stage about to be deleted.
   *
   * The returned messages are the honest part. Deleting cache bytes is always
   * safe and always happens, but a caller that promised the user "the agent is
   * stopped" needs to know when that promise was not kept, so nothing here is
   * swallowed silently.
   */
  async function retireMergeThreads(
    source: Source,
    name: string,
    stopFirst = false,
  ): Promise<string[]> {
    const failures: string[] = [];
    let threads: MergeThread[];
    try {
      threads = await mergeThreads(source, name);
    } catch (cause) {
      // Without a listing we do not know whether an agent is still running.
      return [`the merge threads for "${name}" could not be listed: ${String(cause)}`];
    }
    for (const thread of threads) {
      if (stopFirst) {
        try {
          await bb.sdk.threads.stop({ threadId: thread.id });
        } catch (cause) {
          // Archiving now would hide a thread whose agent is still alive, and
          // a hidden running agent is worse than a visible one.
          failures.push(`thread ${thread.id} could not be stopped: ${String(cause)}`);
          continue;
        }
      }
      try {
        await bb.sdk.threads.archive({ threadId: thread.id });
      } catch (cause) {
        failures.push(`thread ${thread.id} could not be archived: ${String(cause)}`);
      }
    }
    return failures;
  }

  // -------------------------------------------------------------------------
  // Merge signals
  //
  // The panel is told when a merge moves instead of asking on a timer. The
  // agent's only signal is writing SKILL.md into its stage, so a watcher over
  // the stage is what turns that write into something to publish.
  // -------------------------------------------------------------------------

  const mergeWatchers = new Map<string, MergeWatcher>();

  function mergeWatchKey(source: Source, name: string): string {
    return `${source.id} ${name}`;
  }

  /** One signal, one channel: the panel already refetches on `skills-applied`. */
  function publishMergeChange(sourceId: string, name: string): void {
    bb.realtime.publish(SKILLS_APPLIED, { sourceId, merge: name });
  }

  /**
   * At most one watcher per skill, so a reload, a refetch and a fresh start
   * cannot stack watchers on the same directory.
   */
  function watchMerge(source: Source, name: string, token: string): void {
    const key = mergeWatchKey(source, name);
    if (mergeWatchers.has(key)) return;
    try {
      const watcher = watchMergeStage(cacheRoot(), source, name, token, () => {
        mergeWatchers.delete(key);
        publishMergeChange(source.id, name);
      });
      // An already-ready stage finishes the watch inside the call above, so
      // filing that handle would leave a dead entry blocking the next watch.
      if (!watcher.closed) mergeWatchers.set(key, watcher);
    } catch (cause) {
      // Losing a watcher costs liveness, never correctness: the panel still
      // re-reads the state on its next reconnect.
      bb.log.error(`could not watch the merge stage for "${name}": ${String(cause)}`);
    }
  }

  function unwatchMerge(source: Source, name: string): void {
    const key = mergeWatchKey(source, name);
    mergeWatchers.get(key)?.close();
    mergeWatchers.delete(key);
  }

  bb.onDispose(() => {
    for (const watcher of mergeWatchers.values()) watcher.close();
    mergeWatchers.clear();
  });

  function mergePrompt(
    source: Source,
    name: string,
    localDir: string,
    pinDir: string,
    headDir: string,
    stagingDir: string,
    commits: Array<{ sha: string; subject: string }>,
  ): string {
    const commitSummary =
      commits.length === 0
        ? "(none)"
        : commits.map((commit) => `- ${commit.sha} ${commit.subject}`).join("\n");
    return [
      `Merge the installed skill "${name}" from source "${source.id}".`,
      "",
      `Installed version (the user's current copy): ${localDir}`,
      `Pinned ancestor (the common ancestor): ${pinDir}`,
      `Upstream version at HEAD: ${headDir}`,
      `Write the complete merged skill only into this staging directory: ${stagingDir}`,
      "",
      "Upstream commit subjects between the pin and HEAD (newest first):",
      commitSummary,
      "",
      "Work out what the user's edit was FOR by comparing the installed version",
      "against the pinned ancestor. Preserve that intention. Do not preserve the",
      "user's exact words where upstream has genuinely improved the same passage.",
      "Where the user's edit and an upstream change collide and you cannot honestly",
      "serve both, ASK THE USER IN THIS THREAD and wait. Merge everything that is",
      "clear without asking.",
      "",
      "Write a complete skill folder, including SKILL.md and any appropriate",
      "supporting files, into the staging directory. Never write to the user's",
      "skills folder, the repository, or any other path on this machine. Do not",
      "spawn subagents.",
      "",
      "If you cannot produce an honest merge, say so plainly and write nothing.",
      "Giving up is a correct outcome; a bad merge is not.",
    ].join("\n");
  }

  /** Apply once and notify the panel for both RPC and CLI callers. */
  const applyAndPublish = async (
    sourceId: string,
    names: string[],
    bumpMarker: boolean,
    allowConflictOverwrite: boolean,
  ) => {
    const result = applySkills(
      await load(sourceId, false),
      names,
      bumpMarker,
      allowConflictOverwrite,
    );
    if (result.applied.length > 0) {
      bb.realtime.publish(SKILLS_APPLIED, {
        sourceId,
        applied: result.applied,
        marker: result.marker,
      });
    }
    return result;
  };

  if (autoFetch.ok && autoFetch.hours > 0) {
    bb.background.schedule(
      AUTO_FETCH_SCHEDULE,
      "0 */" + autoFetch.hours + " * * *",
      async () => {
        for (const source of sources) {
          const prepared = await load(source.id, true);
          // The scheduled path is intentionally fetch-only. Computing status
          // reads the cached trees and installRoot but cannot install or move
          // the marker.
          statusFrom(prepared);
          bb.realtime.publish(SKILLS_APPLIED, {
            sourceId: source.id,
            changed: true,
          });
        }
      },
    );
  }

  bb.rpc.register(rpcContract, {
    listSources: () => ({ sources }),
    status: async ({ sourceId, refresh }) =>
      statusFrom(await load(sourceId, refresh), autoFetch.ok ? autoFetch.hours : 0),
    diff: async ({ sourceId, name, kind }) => ({
      patch: diffSkill(await load(sourceId, false), name, kind),
    }),
    mergeStart: async ({ sourceId, name }) => {
      const prepared = await load(sourceId, false);
      assertMergeableConflict(prepared, name);
      const token = newMergeToken();
      const stagingDir = mergeStageDir(cacheRoot(), prepared.source, name, token);
      assertMergeStagingLocation(
        prepared.cacheRoot,
        prepared.source.installRoot,
        stagingDir,
      );
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const personal = projects.find((project) => project.kind === "personal");
      if (personal === undefined) {
        throw new SyncError("Cannot start a merge: the personal project is unavailable.");
      }
      const head = prepared.headDir;
      const pin = prepared.pinDir;
      if (pin === null) {
        throw new SyncError("Cannot start a merge without a pinned ancestor.");
      }
      const thread = await bb.sdk.threads.spawn({
        projectId: personal.id,
        environment: { type: "project-default" },
        prompt: mergePrompt(
          prepared.source,
          name,
          path.join(prepared.source.installRoot, name),
          pin,
          head,
          stagingDir,
          prepared.commits,
        ),
        title: mergeThreadTitle(prepared.source, name, token),
        providerId: values.mergeProviderId,
        model: values.mergeModel,
        reasoningLevel: values.mergeReasoningLevel as
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max",
        visibility: "visible",
      });
      watchMerge(prepared.source, name, token);
      publishMergeChange(sourceId, name);
      return { state: "running" as const, threadId: thread.id, stagingDir, error: null };
    },
    mergeState: async ({ sourceId, name }) => {
      const source = findSource(sourceId);
      const { token, ...state } = await currentMergeState(source, name);
      // A merge outlives a plugin reload, so this is also where a running one
      // gets its watcher back. Anything else has nothing left to watch.
      if (state.state === "running" && token !== null) watchMerge(source, name, token);
      else unwatchMerge(source, name);
      return state;
    },
    mergeDiff: async ({ sourceId, name }) => ({
      patch: mergeDiff(await load(sourceId, false), name),
    }),
    mergeAccept: async ({ sourceId, name }) => {
      const prepared = await load(sourceId, false);
      assertMergeableConflict(prepared, name);
      const backup = acceptMerge(prepared, name);
      await retireMergeThreads(prepared.source, name);
      unwatchMerge(prepared.source, name);
      publishMergeChange(sourceId, name);
      return { backup };
    },
    mergeCancel: async ({ sourceId, name }) => {
      const source = findSource(sourceId);
      // Stop the agent before deleting, or it writes back into the stage it is
      // still holding open. Only cache bytes are removed either way.
      const failures = await retireMergeThreads(source, name, true);
      discardMerge(cacheRoot(), source, name);
      unwatchMerge(source, name);
      publishMergeChange(sourceId, name);
      if (failures.length > 0) {
        // The staged bytes are gone, but the agent may still be alive and able
        // to write them back. Saying "cancelled" here would be a lie the user
        // would act on, so the half-done cancel is reported as a failure.
        throw new SyncError(
          `The staged merge for "${name}" was deleted, but the merge could not be ` +
            `fully cancelled: ${failures.join("; ")}. The agent may still be running — ` +
            "open its thread and stop it there.",
        );
      }
      return { ok: true as const };
    },
    mergeDiscard: async ({ sourceId, name }) => {
      const source = findSource(sourceId);
      discardMerge(cacheRoot(), source, name);
      await retireMergeThreads(source, name);
      unwatchMerge(source, name);
      publishMergeChange(sourceId, name);
      return { ok: true as const };
    },
    apply: ({ sourceId, names, bumpMarker, allowConflictOverwrite }) =>
      applyAndPublish(sourceId, names, bumpMarker, allowConflictOverwrite),
  });

  bb.cli.register(
    createCliRunner({
      sources,
      parsed,
      load,
      apply: applyAndPublish,
    }),
  );

  bb.log.info(`loaded with ${sources.length} source(s)`);
}
