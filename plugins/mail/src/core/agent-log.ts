// The agent and AI action log (slice 3f): one content-free row per agent tool
// call, mention, Hand to agent, CLI read in a thread and owner-click model
// call. Rows hold ids, counts, codes, timestamps, the thread id and (for
// owner_ai only) the provider and model setting values; never a query, a
// question, an instruction, a subject, a name, an address, a snippet, a
// result or an error text.

export const LOG_ACTORS = ["agent", "mention", "handoff", "cli", "owner_ai"] as const;
export type LogActor = (typeof LOG_ACTORS)[number];

export const LOG_TOOLS = [
  "search", "read", "contacts", "inbox", "propose", "templates", "triage", "mention", "handoff",
  "cli_search", "cli_read",
  "ai_translate", "ai_summary", "ai_ask", "ai_tasks", "ai_categories", "ai_digest", "ai_draft",
] as const;
export type LogTool = (typeof LOG_TOOLS)[number];

export const LOG_OUTCOMES = [
  "ok", "empty", "refused_off", "refused_scope", "refused_invalid", "refused_caps",
  "proposed", "sent", "opened", "cancelled", "expired", "applied", "failed",
] as const;
export type LogOutcome = (typeof LOG_OUTCOMES)[number];

export type LogEntry = {
  at: string;
  actor: LogActor;
  threadId: string | null;
  tool: LogTool;
  outcome: LogOutcome;
  /** At most AGENT_LOG_IDS_MAX: the plugin's opaque row ids returned or touched. */
  messageIds: string[];
  /** Results returned, or items approved. */
  count: number;
  /** Values redacted in what was handed over. */
  hiddenCount: number;
  /** A proposal or triage batch id. */
  refId: string | null;
  /** owner_ai only: the owner's setting values. */
  provider: string | null;
  model: string | null;
};

export const AGENT_LOG_IDS_MAX = 50;
export const AGENT_LOG_KEEP_DAYS = 90;
export const AGENT_LOG_ROWS_MAX = 20_000;

export type LogEntryInput = {
  actor: LogActor;
  tool: LogTool;
  outcome: LogOutcome;
  threadId?: string | null;
  messageIds?: readonly string[];
  count?: number;
  hiddenCount?: number;
  refId?: string | null;
  provider?: string | null;
  model?: string | null;
};

const wholeCount = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.floor(value));

/** A log row: ids de-duplicated and capped, provider and model kept for owner_ai only, mentions without a thread. */
export function logEntry(input: LogEntryInput, now: Date): LogEntry {
  const ids = [...new Set(input.messageIds ?? [])].slice(0, AGENT_LOG_IDS_MAX);
  const ownerAi = input.actor === "owner_ai";
  return {
    at: now.toISOString(),
    actor: input.actor,
    threadId: input.actor === "mention" ? null : input.threadId ?? null,
    tool: input.tool,
    outcome: input.outcome,
    messageIds: ids,
    count: wholeCount(input.count),
    hiddenCount: wholeCount(input.hiddenCount),
    refId: input.refId ?? null,
    provider: ownerAi ? input.provider ?? null : null,
    model: ownerAi ? input.model ?? null : null,
  };
}

/** What the Agent activity view says a row did. */
export const LOG_TOOL_LABEL: Record<LogTool, string> = {
  search: "Searched mail",
  read: "Read an email",
  contacts: "Looked up people",
  inbox: "Read the Inbox list",
  propose: "Proposed an email",
  templates: "Read your templates",
  triage: "Proposed Inbox changes",
  mention: "Mentioned an email",
  handoff: "Handed an email to the agent",
  cli_search: "Searched mail (CLI)",
  cli_read: "Read an email (CLI)",
  ai_translate: "Translated an email",
  ai_summary: "Summarized a conversation",
  ai_ask: "Answered a question about your mail",
  ai_tasks: "Found tasks",
  ai_categories: "Suggested categories",
  ai_digest: "Summarized Today",
  ai_draft: "Improved your draft",
};

export const LOG_OUTCOME_LABEL: Record<LogOutcome, string> = {
  ok: "Done",
  empty: "Nothing found",
  refused_off: "Refused: turned off",
  refused_scope: "Refused: outside AI access",
  refused_invalid: "Refused: not valid",
  refused_caps: "Refused: limit reached",
  proposed: "Waiting for you",
  sent: "Sent",
  opened: "Opened",
  cancelled: "Cancelled",
  expired: "Expired",
  applied: "Applied",
  failed: "Failed",
};
