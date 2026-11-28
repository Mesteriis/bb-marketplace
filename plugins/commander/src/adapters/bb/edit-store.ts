import type { Database } from "better-sqlite3";
import { EditSession, type WriteBackRequest, writeBackCommand } from "../../core/edit-session.ts";
import { CommanderError } from "../../core/errors.ts";
import type { ResourceRef } from "../../core/model.ts";

export const EDIT_MIGRATION = `
  CREATE TABLE edit_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    ref TEXT NOT NULL UNIQUE,
    base TEXT NOT NULL,
    host_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_saved_at TEXT
  );
  CREATE TABLE edit_writebacks (
    session_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    command TEXT NOT NULL,
    PRIMARY KEY (session_id, client_request_id)
  );
`;

interface SessionRow {
  session_id: string;
  ref: string;
  base: string;
  host_id: string;
  state: string;
  created_at: string;
  last_saved_at: string | null;
}
interface Receipt {
  jobId: string;
  command: string;
  revision: number;
}

function refKey(ref: ResourceRef) {
  return JSON.stringify({ endpoint: ref.endpoint, path: { segments: ref.path.segments } });
}

function session(row: SessionRow) {
  return EditSession.parse({
    sessionId: row.session_id, ref: JSON.parse(row.ref), base: JSON.parse(row.base),
    hostId: row.host_id, state: JSON.parse(row.state), createdAt: row.created_at, lastSavedAt: row.last_saved_at,
  });
}

export function createEditStore(db: Database) {
  const byId = db.prepare<[string], SessionRow>("SELECT * FROM edit_sessions WHERE session_id = ?");
  const byRef = db.prepare<[string], SessionRow>("SELECT * FROM edit_sessions WHERE ref = ?");
  const all = db.prepare<[], SessionRow>("SELECT * FROM edit_sessions");
  const remove = db.prepare<[string]>("DELETE FROM edit_sessions WHERE session_id = ?");
  const insert = db.prepare<SessionRow>(`
    INSERT INTO edit_sessions VALUES (@session_id,@ref,@base,@host_id,@state,@created_at,@last_saved_at)
  `);
  const update = db.prepare<SessionRow>(`
    UPDATE edit_sessions SET base=@base,state=@state,last_saved_at=@last_saved_at WHERE session_id=@session_id
  `);
  const previous = db.prepare<[string, string], Receipt>(`
    SELECT job_id AS jobId, revision, command FROM edit_writebacks WHERE session_id = ? AND client_request_id = ?
  `);
  const remember = db.prepare<[string, string, number, string, string, string]>(`
    INSERT INTO edit_writebacks VALUES (?, ?, ?, ?, ?, ?)
  `);

  function stored(value: EditSession): SessionRow {
    const data = EditSession.parse(value);
    return {
      session_id: data.sessionId, ref: refKey(data.ref), base: JSON.stringify(data.base),
      host_id: data.hostId, state: JSON.stringify(data.state), created_at: data.createdAt, last_saved_at: data.lastSavedAt,
    };
  }

  return {
    get(id: string) {
      const row = byId.get(id);
      return row ? session(row) : null;
    },
    forRef(ref: ResourceRef) {
      const row = byRef.get(refKey(ref));
      return row ? session(row) : null;
    },
    list() { return all.all().map(session); },
    open(value: EditSession) { insert.run(stored(value)); },
    save(value: EditSession) {
      if (update.run(stored(value)).changes !== 1) throw new CommanderError("not_found", "Сеанс завершён — откройте файл снова");
    },
    close(id: string) { remove.run(id); },
    replay(input: WriteBackRequest) {
      const row = previous.get(input.sessionId, input.clientRequestId);
      if (!row) return null;
      if (row.command !== writeBackCommand(input)) {
        throw new CommanderError("changed_since_plan", "Идентификатор запроса уже связан с другой записью");
      }
      return row.jobId;
    },
    record(input: WriteBackRequest, jobId: string, createdAt: string) {
      if (!db.inTransaction) throw new CommanderError("internal", "Writeback receipt requires a job transaction");
      const row = byId.get(input.sessionId);
      if (!row) throw new CommanderError("not_found", "Сеанс завершён — откройте файл снова");
      const value = session(row);
      if (value.state.revision !== input.revision || value.state.pendingJob || value.state.upload) {
        throw new CommanderError("changed_since_plan", "Редакция изменилась — перечитайте копию");
      }
      value.state.pendingJob = jobId;
      value.state.conflict = null;
      remember.run(input.sessionId, input.clientRequestId, input.revision, jobId, createdAt, writeBackCommand(input));
      update.run(stored(value));
    },
  };
}
export type EditStore = ReturnType<typeof createEditStore>;
