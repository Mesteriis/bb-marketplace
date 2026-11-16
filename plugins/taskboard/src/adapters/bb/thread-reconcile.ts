// Reconciles a possibly-spawned thread by runId, scanning BOTH archived and
// non-archived threads (hidden included) and exhausting every page of each.
// Threads are deduped by id before metadata reads. Any failure is
// indeterminate (undefined); a single match is adopted, none is "definitely
// absent" (null), and more than one match is indeterminate.
export interface ReconcileThreadPorts {
  listThreads(args: { projectId: string; originPluginId: string; includeHidden: boolean; archived: boolean; limit: number; offset: number }): Promise<Array<{ id: string; environmentId: string | null }>>;
  getMetadata(threadId: string): Promise<Record<string, unknown>>;
}

export async function reconcileThreadByRunId(
  ports: ReconcileThreadPorts,
  args: { projectId: string; originPluginId: string; runId: string },
): Promise<{ threadId: string; environmentId: string | null } | null | undefined> {
  const { projectId, originPluginId, runId } = args;
  const seen = new Set<string>();
  const matches: { threadId: string; environmentId: string | null }[] = [];
  const limit = 50;
  try {
    for (const archived of [false, true]) {
      let offset = 0;
      for (;;) {
        let page: Array<{ id: string; environmentId: string | null }>;
        try { page = await ports.listThreads({ projectId, originPluginId, includeHidden: true, archived, limit, offset }); }
        catch { return undefined; }
        for (const thread of page) {
          if (seen.has(thread.id)) continue;
          seen.add(thread.id);
          let metadata: Record<string, unknown>;
          try { metadata = await ports.getMetadata(thread.id); }
          catch { return undefined; }
          if (metadata.runId === runId) matches.push({ threadId: thread.id, environmentId: thread.environmentId });
        }
        if (page.length < limit) break;
        offset += page.length;
      }
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) return undefined;
    return { threadId: matches[0].threadId, environmentId: matches[0].environmentId };
  } catch {
    return undefined;
  }
}
