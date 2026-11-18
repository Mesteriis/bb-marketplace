// The audit of agent tool calls (stage 4a). A row is written BEFORE the action runs and its outcome filled in
// afterwards, so a crash leaves a trace. A row holds who (thread, project), what (tool, profile, session) and
// the outcome; never terminal text, keystrokes, screenshots or secrets. `detail` is the length (never a hash: an unkeyed hash of a short typed secret can be guessed offline)
// of an input, or, only when the owner switched "record commands" on for that profile, the command text cut at
// 512 characters; `detailMode` says which of the two was in effect.

export type AuditDetailMode = "none" | "length" | "text";

export interface AuditRow {
  id: number;
  at: string;
  threadId: string;
  projectId: string;
  tool: string;
  profileId: string | null;
  sessionKey: string | null;
  detailMode: AuditDetailMode;
  detail: string | null;
  /** null while the call runs, or for ever after a crash. */
  outcome: string | null;
  /** More than 1 only for a collapsed run of rate-limited calls. */
  count: number;
}

export interface AuditStore {
  begin(row: Omit<AuditRow, "id" | "outcome">): number;
  finish(id: number, outcome: string): void;
  /** Add one to the newest rate-limited row of this thread and tool, if it is not older than `notBefore`. */
  collapse(threadId: string, tool: string, notBefore: string, at: string): boolean;
  list(limit: number): AuditRow[];
  prune(keep: number): void;
}

export interface AuditCall {
  threadId: string;
  projectId: string;
  tool: string;
  profileId?: string | null;
  sessionKey?: string | null;
  detailMode?: AuditDetailMode;
  detail?: string | null;
}

export interface AuditTicket {
  finish(outcome: string): void;
}

export const AUDIT_DETAIL_MAX = 512;

export interface AgentAuditDeps {
  store: AuditStore;
  now: () => Date;
  /** Rows kept (newest). */
  keep?: number;
  collapseWindowMs?: number;
}

export class AgentAudit {
  private readonly keep: number;
  private readonly collapseWindowMs: number;
  constructor(private readonly deps: AgentAuditDeps) {
    this.keep = deps.keep ?? 5000;
    this.collapseWindowMs = deps.collapseWindowMs ?? 60_000;
  }

  begin(call: AuditCall): AuditTicket {
    const id = this.deps.store.begin(this.row(call, 1));
    this.deps.store.prune(this.keep);
    return { finish: (outcome) => this.deps.store.finish(id, outcome) };
  }

  /** A refused call over budget: one row per thread, tool and window, with a count. */
  rateLimited(call: AuditCall): void {
    const at = this.deps.now();
    const notBefore = new Date(at.getTime() - this.collapseWindowMs).toISOString();
    if (this.deps.store.collapse(call.threadId, call.tool, notBefore, at.toISOString())) return;
    const id = this.deps.store.begin(this.row(call, 1));
    this.deps.store.finish(id, "rate_limited");
    this.deps.store.prune(this.keep);
  }

  list(limit: number): AuditRow[] {
    return this.deps.store.list(Math.max(1, Math.min(limit, this.keep)));
  }

  private row(call: AuditCall, count: number): Omit<AuditRow, "id" | "outcome"> {
    return {
      at: this.deps.now().toISOString(),
      threadId: call.threadId,
      projectId: call.projectId,
      tool: call.tool,
      profileId: call.profileId ?? null,
      sessionKey: call.sessionKey ?? null,
      detailMode: call.detailMode ?? "none",
      detail: call.detail === undefined || call.detail === null ? null : call.detail.slice(0, AUDIT_DETAIL_MAX),
      count,
    };
  }
}
