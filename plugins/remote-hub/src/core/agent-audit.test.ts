import { describe, expect, it } from "vitest";
import { AgentAudit, type AuditRow, type AuditStore } from "./agent-audit.ts";

function memoryStore(): AuditStore & { rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  let id = 0;
  return {
    rows,
    begin(row) {
      rows.push({ ...row, id: ++id, outcome: null });
      return id;
    },
    finish(rid, outcome) {
      const r = rows.find((x) => x.id === rid);
      if (r !== undefined) r.outcome = outcome;
    },
    collapse(threadId, tool, notBefore, at) {
      const last = [...rows].reverse().find((r) => r.threadId === threadId && r.tool === tool);
      if (last === undefined || last.outcome !== "rate_limited" || last.at < notBefore) return false;
      last.count += 1;
      last.at = at;
      return true;
    },
    list: (limit) => [...rows].reverse().slice(0, limit),
    prune(keep) {
      while (rows.length > keep) rows.shift();
    },
  };
}
const setup = (keep = 5000) => {
  const store = memoryStore();
  let t = Date.parse("2026-11-18T12:00:00.000Z");
  const audit = new AgentAudit({ store, now: () => new Date(t), keep, collapseWindowMs: 60_000 });
  return { audit, store, advance: (ms: number) => void (t += ms) };
};
const CALL = { threadId: "thr_a", projectId: "prj_1", tool: "remote_terminal_read", profileId: "p", sessionKey: "g:1" };

describe("agent audit", () => {
  it("writes the row BEFORE the action, with no outcome, and fills the outcome in after", () => {
    const { audit, store } = setup();
    const ticket = audit.begin(CALL);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ threadId: "thr_a", projectId: "prj_1", tool: "remote_terminal_read", outcome: null, count: 1, detailMode: "none", detail: null });
    ticket.finish("ok");
    expect(store.rows[0]?.outcome).toBe("ok");
  });

  it("a crash leaves a row without an outcome, which the list shows as unfinished", () => {
    const { audit } = setup();
    audit.begin(CALL);
    expect(audit.list(10)[0]).toMatchObject({ outcome: null });
  });

  it("keeps only the newest rows", () => {
    const { audit, store } = setup(3);
    for (let i = 0; i < 6; i++) audit.begin({ ...CALL, tool: "t" + i }).finish("ok");
    expect(store.rows.map((r) => r.tool)).toEqual(["t3", "t4", "t5"]);
  });

  it("a flood of rate-limited calls is ONE row with a count, not a row per call", () => {
    const { audit, store, advance } = setup();
    audit.rateLimited(CALL);
    advance(1000);
    audit.rateLimited(CALL);
    audit.rateLimited(CALL);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ outcome: "rate_limited", count: 3 });
    // Another thread, or a later window, is a new row.
    audit.rateLimited({ ...CALL, threadId: "thr_b" });
    advance(120_000);
    audit.rateLimited(CALL);
    expect(store.rows).toHaveLength(3);
  });

  it("detail is cut at 512 characters and says which mode was in effect", () => {
    const { audit, store } = setup();
    audit.begin({ ...CALL, tool: "remote_ssh_exec", detailMode: "text", detail: "x".repeat(2000) });
    expect(store.rows[0]?.detail).toHaveLength(512);
    expect(store.rows[0]?.detailMode).toBe("text");
  });

  it("lists newest first", () => {
    const { audit } = setup();
    audit.begin({ ...CALL, tool: "a" }).finish("ok");
    audit.begin({ ...CALL, tool: "b" }).finish("ok");
    expect(audit.list(10).map((r) => r.tool)).toEqual(["b", "a"]);
  });
});
