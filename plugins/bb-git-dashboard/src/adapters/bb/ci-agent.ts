import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isActive } from "../../core/ci/model.ts";
import { failurePrompt } from "../../core/ci/prompt.ts";
import { failureKey, newFailures } from "../../core/ci/watch.ts";
import type { Copy } from "../../core/workspace.ts";
import type { ciService } from "./ci-service.ts";

type Service = ReturnType<typeof ciService>;
const forgeNames = {github: "GitHub", gitlab: "GitLab", gitea: "Gitea", azure: "Azure DevOps"} as const;
const subscriptionKey = (copyId: string) => "ci-subscription/" + copyId;
const seenKey = (copyId: string) => "ci-seen/" + copyId;
const askKey = (copyId: string, failure: string) => "ci-ask/" + copyId + "/" + failure;
const codeOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "THREAD_UNAVAILABLE";

/** Hands failed runs to agents: a new investigation thread, messages to chosen threads, and subscriptions. */
export function ciAgent(bb: BbPluginApi, service: Service, changed: (copyId: string) => void) {
  const kv = bb.storage.kv;
  const asking = new Map<string, Promise<{threadId: string; created: boolean}>>();

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

  async function projectThreads(copyId: string) {
    const {copy} = await service.context(copyId);
    return bb.sdk.threads.list({projectId: projectOf(copy), archived: false, limit: 100});
  }

  /** Only threads of the copy's own project may receive its CI output. */
  async function ownThreads(copyId: string, threadIds: string[]) {
    const allowed = new Set((await projectThreads(copyId)).map(thread => thread.id));
    if (threadIds.some(id => !allowed.has(id))) throw new Error("ACCESS_DENIED");
    return [...new Set(threadIds)];
  }

  /** One round for one copy: new failures go to the subscribed threads and are remembered once delivered. */
  async function watchOnce(copyId: string) {
    const threads = await kv.get<string[]>(subscriptionKey(copyId)) ?? [];
    if (!threads.length) return {active: false};
    const {items} = await service.runs(copyId, "all", 1);
    const active = items.some(run => isActive(run.state));
    const previous = await kv.get<string[]>(seenKey(copyId)) ?? null;
    const result = newFailures(previous, items);
    if (previous === null) { await kv.set(seenKey(copyId), result.seen); return {active}; }
    const delivered: string[] = [];
    for (const run of result.failed) {
      try {
        if ((await send(threads, (await prompt(copyId, run.id, null)).text)).sent.length) delivered.push(failureKey(run));
      } catch { /* Not delivered: the next round tries this failure again. */ }
    }
    if (delivered.length) {
      await kv.set(seenKey(copyId), [...delivered, ...previous].slice(0, 200));
      changed(copyId);
    }
    return {active};
  }

  bb.background.service("ci-watch", {
    async start(signal) {
      while (!signal.aborted) {
        let active = false;
        for (const key of await kv.list("ci-subscription/").catch(() => [] as string[])) {
          if (signal.aborted) break;
          try { active = (await watchOnce(key.slice("ci-subscription/".length))).active || active; }
          catch { /* The next round retries; the panel shows the error when opened. */ }
        }
        await new Promise<void>(resolve => {
          const stop = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, active ? 15_000 : 60_000);
          signal.addEventListener("abort", stop, {once: true});
        });
      }
    },
  });

  return {
    watchOnce,
    async threads(copyId: string) {
      const rows = await projectThreads(copyId);
      return {threads: rows.map(row => ({id: row.id, title: row.title || row.id})), subscribed: await kv.get<string[]>(subscriptionKey(copyId)) ?? []};
    },
    async ask(copyId: string, runId: string, jobId: string | null) {
      const {run, copy, text} = await prompt(copyId, runId, jobId);
      const key = askKey(copyId, failureKey(run));
      const pending = asking.get(key);
      if (pending) return {...await pending, created: false};
      const work = (async () => {
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
      })();
      asking.set(key, work);
      try { return await work; } finally { asking.delete(key); }
    },
    send: async (copyId: string, runId: string, jobId: string | null, threadIds: string[]) =>
      send(await ownThreads(copyId, threadIds), (await prompt(copyId, runId, jobId)).text),
    async subscribe(copyId: string, threadIds: string[]) {
      const subscribed = threadIds.length ? await ownThreads(copyId, threadIds) : [];
      if (subscribed.length) await kv.set(subscriptionKey(copyId), subscribed);
      else { await kv.delete(subscriptionKey(copyId)); await kv.delete(seenKey(copyId)); }
      return {subscribed};
    },
  };
}
