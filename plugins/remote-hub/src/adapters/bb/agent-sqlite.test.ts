import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentAccessBook } from "../../core/agent-access.ts";
import { AgentAudit } from "../../core/agent-audit.ts";
import { AgentSettings } from "../../core/agent-settings.ts";
import { AGENT_MIGRATIONS, createSqliteAgentAuditStore, createSqliteAgentGrantStore, createSqliteAgentSettingsStore } from "./agent-sqlite.ts";
import { ALL_MIGRATIONS } from "./migrations.ts";

const P1 = "11111111-2222-4333-8444-555555555551";
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  for (const statement of ALL_MIGRATIONS) db.exec(statement);
});
afterEach(() => db.close());

describe("agent settings in SQLite", () => {
  it("require watching is on until the owner turns it off, and the choice survives a restart", () => {
    expect(new AgentSettings(createSqliteAgentSettingsStore(db)).requireWatching()).toBe(true);
    new AgentSettings(createSqliteAgentSettingsStore(db)).setRequireWatching(false);
    expect(new AgentSettings(createSqliteAgentSettingsStore(db)).requireWatching()).toBe(false);
    new AgentSettings(createSqliteAgentSettingsStore(db)).setRequireWatching(true);
    expect(new AgentSettings(createSqliteAgentSettingsStore(db)).requireWatching()).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_settings").get()).toEqual({ n: 1 });
  });

  it("a stored value that is not exactly 'off' is read as the strict default", () => {
    db.prepare("INSERT INTO agent_settings (key, value) VALUES ('require_watching', 'maybe')").run();
    expect(new AgentSettings(createSqliteAgentSettingsStore(db)).requireWatching()).toBe(true);
  });
});

describe("agent grants in SQLite", () => {
  it("are appended after every earlier migration and survive a restart", () => {
    expect(ALL_MIGRATIONS.slice(-AGENT_MIGRATIONS.length)).toEqual(AGENT_MIGRATIONS);
    const book = new AgentAccessBook({ store: createSqliteAgentGrantStore(db), profiles: { has: () => true }, now: () => new Date("2026-11-18T12:00:00.000Z") });
    book.set(P1, "exec", true);
    const again = new AgentAccessBook({ store: createSqliteAgentGrantStore(db), profiles: { has: () => true }, now: () => new Date() });
    expect(again.get(P1)).toEqual({ profileId: P1, level: "exec", recordCommands: true, updatedAt: "2026-11-18T12:00:00.000Z" });
    again.set(P1, "none", false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM profile_agent_access").get()).toEqual({ n: 0 });
  });

  it("a row with a level this version does not know grants nothing", () => {
    db.prepare("INSERT INTO profile_agent_access (profile_id, level, record_commands, updated_at) VALUES (?, 'root', 0, 'x')").run(P1);
    const book = new AgentAccessBook({ store: createSqliteAgentGrantStore(db), profiles: { has: () => true }, now: () => new Date() });
    expect(book.check(P1, "observe")).toEqual({ ok: false, code: "agent_access_denied" });
    expect(book.list()).toEqual([]);
  });

  it("revoke all deletes every row", () => {
    const store = createSqliteAgentGrantStore(db);
    const book = new AgentAccessBook({ store, profiles: { has: () => true }, now: () => new Date() });
    book.set(P1, "observe", false);
    book.set("11111111-2222-4333-8444-555555555552", "input", false);
    expect(book.revokeAll()).toBe(2);
    expect(store.all()).toEqual([]);
  });
});

describe("the agent audit in SQLite", () => {
  const audit = (keep = 5000) => {
    let t = Date.parse("2026-11-18T12:00:00.000Z");
    const a = new AgentAudit({ store: createSqliteAgentAuditStore(db), now: () => new Date(t), keep, collapseWindowMs: 60_000 });
    return { a, advance: (ms: number) => void (t += ms) };
  };
  const call = { threadId: "thr_a", projectId: "prj_1", tool: "remote_terminal_read", profileId: P1, sessionKey: "g.1" };

  it("stores the row before the outcome and fills it in after; an unfinished row stays unfinished", () => {
    const { a } = audit();
    const ticket = a.begin(call);
    expect(db.prepare("SELECT outcome, count, detail_mode FROM agent_audit").all()).toEqual([{ outcome: null, count: 1, detail_mode: "none" }]);
    ticket.finish("ok");
    a.begin({ ...call, tool: "remote_session_status" });
    expect(a.list(10).map((r) => [r.tool, r.outcome])).toEqual([["remote_session_status", null], ["remote_terminal_read", "ok"]]);
  });

  it("keeps the newest rows only", () => {
    const { a } = audit(3);
    for (let i = 0; i < 7; i++) a.begin({ ...call, tool: "t" + i }).finish("ok");
    expect(a.list(10).map((r) => r.tool)).toEqual(["t6", "t5", "t4"]);
  });

  it("rate-limited refusals collapse into one counted row per thread, tool and window", () => {
    const { a, advance } = audit();
    a.rateLimited(call);
    advance(1000);
    a.rateLimited(call);
    a.rateLimited(call);
    expect(db.prepare("SELECT outcome, count FROM agent_audit").all()).toEqual([{ outcome: "rate_limited", count: 3 }]);
    a.rateLimited({ ...call, threadId: "thr_b" });
    advance(120_000);
    a.rateLimited(call);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_audit").get()).toEqual({ n: 3 });
  });
});

describe("Z7: no hash of an input in the audit", () => {
  it("an old row written with a hash is read as its length only", () => {
    db.prepare("INSERT INTO agent_audit (at, thread_id, project_id, tool, profile_id, session_key, detail_mode, detail, outcome, count) VALUES ('2026-01-01T00:00:00.000Z','t','p','remote_terminal_input',NULL,'g.1','hash','len 8 sha 1a2b3c4d','ok',1)").run();
    const rows = createSqliteAgentAuditStore(db).list(5);
    expect(rows[0]).toMatchObject({ detailMode: "length", detail: "len 8" });
    expect(JSON.stringify(rows)).not.toContain("1a2b3c4d");
  });
});
