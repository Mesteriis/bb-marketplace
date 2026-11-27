import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { failurePrompt } from "../../core/ci/prompt.ts";
import { newFailures } from "../../core/ci/watch.ts";
import type { Copy } from "../../core/workspace.ts";
import type { ciService } from "./ci-service.ts";

type Service = ReturnType<typeof ciService>;
const forgeNames = {github: "GitHub", gitlab: "GitLab", gitea: "Gitea", azure: "Azure DevOps"} as const;
const subscriptionKey = (copyId: string) => "ci-subscription/" + copyId;
const seenKey = (copyId: string) => "ci-seen/" + copyId;
const askKey = (copyId: string, runId: string, attempt: number) => "ci-ask/" + copyId + "/" + runId + "#" + attempt;
const codeOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "THREAD_UNAVAILABLE";

/** Hands failed runs to agents: a new investigation thread, messages to chosen threads, and subscriptions. */
export function ciAgent(bb: BbPluginApi, service: Service, changed: (copyId: string) => void) {
  const kv = bb.storage.kv;

  async function prompt(copyId: string, runId: string, jobId: string | null) {
    const {copy, linked, api} = await service.context(copyId);
    const run = await api.run(runId);
    const {job, lines} = await service.excerpt(api, runId, jobId);
    return {run, copy,
      text: failurePrompt({forge: forgeNames[linked.account.kind], repository: linked.repo.path, run, job, excerpt: lines})};
  }

  async function send(threadIds: string[], text: string) {
    const sent: string[] = [];
    const failed: {threadId: string; code: string}[] = [];
    for (const threadId of new Set(threadIds)) {
      try {
        await bb.sdk.threads.send({threadId, mode: "queue-if-active", input: [{type: "text", text, mentions: []}]});
        sent.push(threadId);
      } catch (error) { failed.push({threadId, code: codeOf(error)}); }
    }
    return {sent, failed};
  }

  function projectOf(copy: Copy) {
    if (!copy.projectId) throw new Error("PROJECT_REQUIRED");
    return copy.projectId;
  }

  bb.background.service("ci-watch", {
    async start(signal) {
      while (!signal.aborted) {
        let active = false;
        for (const key of await kv.list("ci-subscription/").catch(() => [] as string[])) {
          if (signal.aborted) break;
          const copyId = key.slice("ci-subscription/".length);
          const threads = await kv.get<string[]>(key) ?? [];
          if (!threads.length) continue;
          try {
            const {items} = await service.runs(copyId, "all", 1);
            active ||= items.some(run => run.state === "running" || run.state === "queued");
            const result = newFailures(await kv.get<string[]>(seenKey(copyId)) ?? null, items);
            await kv.set(seenKey(copyId), result.seen);
            for (const run of result.failed) await send(threads, (await prompt(copyId, run.id, null)).text);
            if (result.failed.length) changed(copyId);
          } catch { /* The next round retries; the panel shows the error when opened. */ }
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, active ? 15_000 : 60_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, {once: true});
        });
      }
    },
  });

  return {
    async threads(copyId: string) {
      const {copy} = await service.context(copyId);
      const rows = await bb.sdk.threads.list({projectId: projectOf(copy), archived: false, limit: 100});
      return {threads: rows.map(row => ({id: row.id, title: row.title || row.id})), subscribed: await kv.get<string[]>(subscriptionKey(copyId)) ?? []};
    },
    async ask(copyId: string, runId: string, jobId: string | null) {
      const {run, copy, text} = await prompt(copyId, runId, jobId);
      const key = askKey(copyId, runId, run.attempt);
      const existing = await kv.get<string>(key);
      if (existing) return {threadId: existing, created: false};
      const spawned = await bb.sdk.threads.spawn({
        projectId: projectOf(copy), prompt: text,
        title: "CI failed: " + run.workflow + " #" + (run.number ?? run.id) + (run.branch ? " (" + run.branch + ")" : ""),
        environment: {type: "host", hostId: copy.hostId, workspace: {type: "unmanaged", path: copy.root}},
      });
      const record = spawned as {threadId?: string; id?: string};
      const threadId = record.threadId ?? record.id;
      if (!threadId) throw new Error("OUTCOME_UNKNOWN");
      await kv.set(key, threadId);
      return {threadId, created: true};
    },
    send: async (copyId: string, runId: string, jobId: string | null, threadIds: string[]) => send(threadIds, (await prompt(copyId, runId, jobId)).text),
    async subscribe(copyId: string, threadIds: string[]) {
      await service.context(copyId);
      if (threadIds.length) await kv.set(subscriptionKey(copyId), [...new Set(threadIds)]);
      else { await kv.delete(subscriptionKey(copyId)); await kv.delete(seenKey(copyId)); }
      return {subscribed: [...new Set(threadIds)]};
    },
  };
}
