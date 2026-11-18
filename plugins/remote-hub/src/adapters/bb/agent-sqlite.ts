// SQLite storage for agent grants and the agent audit (stage 4a). Metadata only: levels, thread ids, tool names,
// outcome codes. Never terminal text, keystrokes, screenshots or secrets.
import type Database from "better-sqlite3";
import { AGENT_LEVELS, type AgentGrant, type AgentGrantStore, type AgentLevel } from "../../core/agent-access.ts";
import type { AuditRow, AuditStore } from "../../core/agent-audit.ts";

/** Appended after every earlier migration (see migrations.ts). */
export const AGENT_MIGRATIONS: string[] = [
  `CREATE TABLE profile_agent_access (
    profile_id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    record_commands INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    profile_id TEXT,
    session_key TEXT,
    detail_mode TEXT NOT NULL,
    detail TEXT,
    outcome TEXT,
    count INTEGER NOT NULL
  );
  CREATE INDEX agent_audit_thread_tool ON agent_audit (thread_id, tool, id);`,
];

interface GrantRow {
  profile_id: string;
  level: string;
  record_commands: number;
  updated_at: string;
}

interface AuditDbRow {
  id: number;
  at: string;
  thread_id: string;
  project_id: string;
  tool: string;
  profile_id: string | null;
  session_key: string | null;
  detail_mode: string;
  detail: string | null;
  outcome: string | null;
  count: number;
}

const toGrant = (row: GrantRow): AgentGrant | null =>
  (AGENT_LEVELS as readonly string[]).includes(row.level) && row.level !== "none"
    ? { profileId: row.profile_id, level: row.level as AgentLevel, recordCommands: row.record_commands === 1, updatedAt: row.updated_at }
    : null; // a level this version does not know grants nothing

export function createSqliteAgentGrantStore(db: Database.Database): AgentGrantStore {
  return {
    all: () => (db.prepare("SELECT * FROM profile_agent_access ORDER BY rowid").all() as GrantRow[]).flatMap((r) => toGrant(r) ?? []),
    get: (id) => {
      const row = db.prepare("SELECT * FROM profile_agent_access WHERE profile_id = ?").get(id) as GrantRow | undefined;
      return row === undefined ? null : toGrant(row);
    },
    put: (g) => {
      db.prepare(
        `INSERT INTO profile_agent_access (profile_id, level, record_commands, updated_at) VALUES (@id, @level, @rc, @at)
         ON CONFLICT(profile_id) DO UPDATE SET level=@level, record_commands=@rc, updated_at=@at`,
      ).run({ id: g.profileId, level: g.level, rc: g.recordCommands ? 1 : 0, at: g.updatedAt });
    },
    remove: (id) => db.prepare("DELETE FROM profile_agent_access WHERE profile_id = ?").run(id).changes > 0,
    clear: () => db.prepare("DELETE FROM profile_agent_access").run().changes,
  };
}

const toAudit = (r: AuditDbRow): AuditRow => ({
  id: r.id,
  at: r.at,
  threadId: r.thread_id,
  projectId: r.project_id,
  tool: r.tool,
  profileId: r.profile_id,
  sessionKey: r.session_key,
  // Rows written before the hash was dropped (mode "hash", `len N sha xxxxxxxx`) are shown as their length only.
  detailMode: r.detail_mode === "text" ? "text" : r.detail_mode === "length" || r.detail_mode === "hash" ? "length" : "none",
  detail: r.detail_mode === "hash" ? (r.detail ?? "").replace(/ sha [0-9a-f]+$/, "") : r.detail,
  outcome: r.outcome,
  count: r.count,
});

export function createSqliteAgentAuditStore(db: Database.Database): AuditStore {
  return {
    begin(row) {
      const info = db
        .prepare(
          `INSERT INTO agent_audit (at, thread_id, project_id, tool, profile_id, session_key, detail_mode, detail, outcome, count)
           VALUES (@at, @thread, @project, @tool, @profile, @session, @mode, @detail, NULL, @count)`,
        )
        .run({ at: row.at, thread: row.threadId, project: row.projectId, tool: row.tool, profile: row.profileId, session: row.sessionKey, mode: row.detailMode, detail: row.detail, count: row.count });
      return Number(info.lastInsertRowid);
    },
    finish: (id, outcome) => void db.prepare("UPDATE agent_audit SET outcome = ? WHERE id = ?").run(outcome, id),
    collapse(threadId, tool, notBefore, at) {
      const last = db.prepare("SELECT id, outcome, at FROM agent_audit WHERE thread_id = ? AND tool = ? ORDER BY id DESC LIMIT 1").get(threadId, tool) as { id: number; outcome: string | null; at: string } | undefined;
      if (last === undefined || last.outcome !== "rate_limited" || last.at < notBefore) return false;
      db.prepare("UPDATE agent_audit SET count = count + 1, at = ? WHERE id = ?").run(at, last.id);
      return true;
    },
    list: (limit) => (db.prepare("SELECT * FROM agent_audit ORDER BY id DESC LIMIT ?").all(limit) as AuditDbRow[]).map(toAudit),
    prune: (keep) => void db.prepare("DELETE FROM agent_audit WHERE id <= (SELECT MAX(id) FROM agent_audit) - ?").run(keep),
  };
}
