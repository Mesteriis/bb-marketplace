// BB implementations of the lifecycle ports (projects, run spawn, worklog).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { jiraClientFor, type ProjectProvider, type RunSpawner, type SyncDeps, type WorklogSink } from "../../core/index.ts";
import { hostContract } from "./host-contract.ts";
import { reconcileThreadByRunId } from "./thread-reconcile.ts";

export function createProjectProvider(bb: BbPluginApi): ProjectProvider {
  return {
    async listProjects() {
      const projects = await bb.sdk.projects.list();
      return projects.map((project) => ({ id: project.id, name: project.name }));
    },
  };
}

export function createRunSpawner(bb: BbPluginApi): RunSpawner {
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  return {
    async reconcile(runId, projectId) {
      const result = await reconcileThreadByRunId({
        listThreads: (args) => bb.sdk.threads.list(args).then((threads) => threads.map((thread) => ({ id: thread.id, environmentId: thread.environmentId ?? null }))),
        getMetadata: (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }).then((metadata) => metadata as Record<string, unknown>),
      }, { projectId, originPluginId: bb.pluginId, runId });
      if (result === null || result === undefined) return result;
      return { threadId: result.threadId, environmentId: result.environmentId, branchName: null };
    },
    async spawn(input) {
      const project = await bb.sdk.projects.get({ projectId: input.projectId });
      const sources = (project.sources ?? []).filter((source) => source.type === "local_path");
      const defaultSource = sources.find((source) => source.isDefault) ?? (sources.length === 1 ? sources[0] : undefined);
      if (defaultSource === undefined) {
        throw new Error("Project has no single default local checkout");
      }
      const runId = input.metadata.runId ?? input.branchName;
      const worktree = await hostClient.call(
        "createWorktree",
        { repoPath: defaultSource.path, branchName: input.branchName, baseBranch: "HEAD", runId },
        { hostId: defaultSource.hostId },
      );
      const thread = await bb.sdk.threads.spawn({
        projectId: input.projectId,
        environment: { type: "host", hostId: defaultSource.hostId, workspace: { type: "unmanaged", path: worktree.worktreePath, branch: { kind: "existing", name: worktree.branch } } },
        prompt: input.prompt,
        title: input.title,
        pluginMetadata: input.metadata,
      });
      return { threadId: thread.id, environmentId: thread.environmentId ?? null, branchName: worktree.branch };
    },
  };
}

export function createWorklogSink(syncDeps: SyncDeps): WorklogSink {
  return {
    async submitRemoteWorklog(input) {
      const client = jiraClientFor(input.connectionId, syncDeps);
      const result = await client.submitWorklog({ issueKey: input.issueKey, timeSpentSeconds: input.durationSeconds, comment: input.comment, startedAtIso: input.startedAtIso });
      return { id: result.id };
    },
  };
}
