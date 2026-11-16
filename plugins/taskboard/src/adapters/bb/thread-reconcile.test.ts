import { describe, expect, it } from "vitest";
import { reconcileThreadByRunId, type ReconcileThreadPorts } from "./thread-reconcile.ts";

function thread(id: string) { return { id, environmentId: "e_" + id }; }

describe("reconcileThreadByRunId", () => {
  it("finds a match that is archived only", async () => {
    const ports: ReconcileThreadPorts = {
      async listThreads(args) { return args.archived ? [thread("t1")] : []; },
      async getMetadata() { return { runId: "run1" }; },
    };
    const result = await reconcileThreadByRunId(ports, { projectId: "p1", originPluginId: "tb", runId: "run1" });
    expect(result).toEqual({ threadId: "t1", environmentId: "e_t1" });
  });

  it("dedupes a thread listed in both archived states", async () => {
    const ports: ReconcileThreadPorts = {
      async listThreads() { return [thread("t1")]; },
      async getMetadata() { return { runId: "run1" }; },
    };
    const result = await reconcileThreadByRunId(ports, { projectId: "p1", originPluginId: "tb", runId: "run1" });
    expect(result).toEqual({ threadId: "t1", environmentId: "e_t1" });
  });

  it("returns undefined when either archived state fails", async () => {
    const ports: ReconcileThreadPorts = {
      async listThreads(args) { if (args.archived) throw new Error("boom"); return []; },
      async getMetadata() { return {}; },
    };
    expect(await reconcileThreadByRunId(ports, { projectId: "p1", originPluginId: "tb", runId: "r" })).toBeUndefined();
  });

  it("exhausts pages of both states and returns null when nothing matches", async () => {
    const offsets: Array<{ archived: boolean; offset: number }> = [];
    const ports: ReconcileThreadPorts = {
      async listThreads(args) {
        offsets.push({ archived: args.archived, offset: args.offset });
        if (args.offset === 0) return Array.from({ length: 50 }, (_, i) => thread("t" + (args.archived ? "a" : "n") + i));
        return [];
      },
      async getMetadata() { return { runId: "other" }; },
    };
    const result = await reconcileThreadByRunId(ports, { projectId: "p1", originPluginId: "tb", runId: "run1" });
    expect(result).toBeNull();
    expect(offsets).toEqual([{ archived: false, offset: 0 }, { archived: false, offset: 50 }, { archived: true, offset: 0 }, { archived: true, offset: 50 }]);
  });
});
