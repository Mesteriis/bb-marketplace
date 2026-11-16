// The slice 3g owner methods behind server.ts: mail handed to BB as a thread
// or a task, attachments saved into a project's working tree, project and
// thread files attached to a draft, and a thread's result as a draft.
//
// Rules this module keeps (spec "Security and privacy", resolutions 4, 5, 8,
// 13 and 16):
// - Every text that reaches BB comes from bb-text.ts (redacted, quotes
//   stripped, the AI access scope checked first). Nothing else of a mail is
//   handed over.
// - Mail decides where a BB thread came from by its own bb_links rows, never
//   by thread metadata (metadataFor is written for BB's attribution only).
// - Saves are create-only through ProjectDirectory.write; Replace passes the
//   sha the owner was shown.
// - Agent-log rows, log lines and refusals carry ids, counts and fixed texts
//   only: never a path, project name, title, prompt or file name.
import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import {
  BB_REFUSAL_TEXT,
  BINDINGS_MAX,
  RULE_CAPS,
  RULES_MAX,
  alertClass,
  isBulkRow,
  mailRuleMatches,
  ownAddresses,
  ruleCandidates,
  rulePrompt,
  validateRule,
  DEV_KINDS,
  INCIDENT_APPEND_DAYS,
  PATCH_FILES_MAX,
  PATCH_MAX_BYTES,
  alertFingerprint,
  alertOf,
  bodyPlainText,
  devLinks,
  incidentPrompt,
  incidentTitle,
  incidentUpdate,
  isPatchAttachment,
  normalizeListId,
  parsePatch,
  patchFileName,
  patchFromBody,
  patchPrompt,
  patchRef,
  redactSecrets,
  repoRefOf,
  scanHtml,
  BbPortError,
  BbTextOutOfScope,
  ComposeError,
  MARKDOWN_INPUT_MAX,
  PROJECT_PATH_REFUSAL_TEXT,
  addComposeAttachment,
  attachmentRoom,
  isQueued,
  keepBothName,
  markdownToDoc,
  metadataFor,
  newCompose,
  normalizeDoc,
  prepareCompose,
  projectFolder,
  projectRelativePath,
  removeControls,
  removeInvisible,
  safeContentType,
  sanitizeFileName,
  savedName,
  sensitiveName,
  taskText,
  threadPrompt,
  threadTitle,
  underGit,
  type AlertParts,
  type BindingKind,
  type BindingRow,
  type BbLinkRow,
  type BbMessage,
  type DevGroupRow,
  type Rule,
  type RuleMatch,
  type RuleRecord,
  type RuleRunRecord,
  type RuleRunState,
  type IncidentRow,
  type ProjectRemote,
  type BbPermissionMode,
  type BbThreads,
  type Clock,
  type ComposeDeps,
  type ComposeDoc,
  type DraftRecord,
  type LogEntryInput,
  type MailStore,
  type MessageHeader,
  type ProjectDirectory,
  type ProjectInfo,
  type SaveResult,
  type TaskTarget,
  type ThreadDetail,
  type WorkingTree,
} from "../../core/index.ts";
import { SAVE_TO_PROJECT_ENABLED } from "./bb-projects.ts";
import { projectDefaultEnvironment, worktreeEnvironment } from "./bb-threads.ts";
import { RawRefusal, STALE_MESSAGE, fetchRawGuarded, type RawDeps } from "./downloads.ts";
import { parseMail } from "./imapflow-gateway.ts";

/** Fixed texts of BB port failures (BbPortError codes); none names a path or a project. */
export const BB_PORT_TEXT = {
  not_found: "Not found in BB",
  refused: "BB refused the request",
  failed: "BB did not answer; try again",
  disabled: BB_REFUSAL_TEXT.save_disabled,
} as const;
export const UNKNOWN_PROJECT_TEXT = "Unknown project";
export const UNKNOWN_MESSAGE_TEXT = "Unknown message";
export const UNKNOWN_RULE_RUN_TEXT = "Unknown rule run";
export const NO_ATTACHMENTS_TEXT = "Choose the attachments to save";
export const REPLACE_NEEDS_SHA_TEXT = "Replace needs the file you were shown";
export const FILE_TOO_LARGE_TEXT = "The file is larger than 25 MB";
export const SAVE_TOO_LARGE_TEXT = "More than 100 MB in one save";
export const NAME_TAKEN_TEXT = "Too many files with this name in the folder";
export const UNKNOWN_ATTACHMENT_TEXT = "Unknown attachment";
export const GIT_FILE_TEXT = "Files under .git are not offered";
export const DRAFT_ROOM_TEXT = "The draft has no room for this file";
export const NO_PATCH_TEXT = "This email holds no patch";
export const PATCH_TOO_LARGE_TEXT = "The patch is larger than 1 MB";
export const PATCH_CHANGED_TEXT = "The patch changed; open it again";
export const NOT_ALERT_TEXT = "This email is not an alert";
export const INCIDENT_OPEN_TEXT = "An incident thread is open for this alert; add this email to it";
export const NO_INCIDENT_TEXT = "No incident thread for this alert";
export const INCIDENT_OLD_TEXT = "The incident thread had no update for 7 days; start a new one";
export const INCIDENT_GONE_TEXT = "The incident thread was archived or deleted";
export const BINDING_INVALID_TEXT: Record<BindingKind, string> = {
  address: "Enter an email address",
  domain: "Enter a domain such as example.com",
  list: "Enter a mailing list id",
  repo: "Enter a repository as host/owner/repo",
};
export const BINDINGS_FULL_TEXT = "You have the most binding rules Makosh Mail keeps (500); remove some first";
export const UNKNOWN_BINDING_TEXT = "Unknown binding rule";
export const REMOVED_PROJECT_NAME = "Removed project";
export const RULE_THREAD_MESSAGE = "Mail is not available in threads started by a mail rule";
export const RULES_FULL_TEXT = `You have the most mail rules Makosh Mail keeps (${RULES_MAX}); remove some first`;
export const UNKNOWN_RULE_TEXT = "Unknown rule";
/** Starting runs older than this at start-up never got their thread: they become failed. */
export const STALE_START_MS = 10 * 60 * 1000;

/** One attachment saved into a project: at most this many bytes. */
export const SAVE_PART_MAX_BYTES = 25 * 1024 * 1024;
/** One save call: at most this many bytes in all. */
export const SAVE_CALL_MAX_BYTES = 100 * 1024 * 1024;
/** A BB file attached to a draft: at most this many bytes. */
export const BB_ATTACH_MAX_BYTES = 25 * 1024 * 1024;
/** Attachments saved with a thread start ("Also save the attachments"). */
const START_SAVE_PARTS_MAX = 20;
const KEEP_BOTH_MAX = 99;
const DRAFT_SUBJECT_MAX = 200;
/** Dev view groups a page. */
const DEV_DIGEST_PAGE = 50;
const DEV_DIGEST_DAYS = 7;
/** Today's dev line reads at most this many groups. */
const TODAY_DEV_GROUPS = 1_000;
const PROJECT_MAIL_PAGE = 50;
const RULE_RUNS_PAGE = 50;
const INFO_THREADS = 5;
/** bb_thread_mail's total counts at most this many conversations. */
const INFO_TOTAL_MAX = 500;
const DAY_MS = 86_400_000;
const ADDRESS = /^[^\s@<>]{1,64}@[^\s@<>]{1,253}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type BbSettings = {
  attachmentFolder: string;
  patchFolder: string;
  taskTarget: "auto" | "taskboard" | "local";
  devNotifications: boolean;
};

export type BbRpcDeps = {
  store: MailStore;
  clock: Clock;
  newId: () => string;
  projects: ProjectDirectory;
  threads: BbThreads;
  tasks: TaskTarget;
  rawDeps: RawDeps;
  composeDeps: ComposeDeps;
  /** The draft behind a compose call (hidden agent-proposal drafts refused). */
  ownerDraft: (draftId: string) => DraftRecord;
  settings: () => BbSettings;
  agentLog: (input: LogEntryInput) => number | null;
  publishChanged: (accountId: string | null) => void;
  log: (line: string) => void;
  /** Saving into a project (SAVE_TO_PROJECT_ENABLED; tests turn it off). */
  saveEnabled?: boolean;
};

export function refuse(code: "conflict" | "forbidden" | "invalid" | "not_found", message: string): Error {
  return new experimental_PluginRpcRefusal({ code, message });
}

/** Name and code of a failure, never its message. */
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? `${error.name} ${code}` : error.name;
}

/** A BB call's failure as a fixed-text refusal; refusals pass through. */
export function bbRefusal(error: unknown, log: (line: string) => void, method: string): Error {
  if (error instanceof experimental_PluginRpcRefusal) return error;
  if (error instanceof BbTextOutOfScope) return refuse("conflict", BB_REFUSAL_TEXT.out_of_scope);
  if (error instanceof BbPortError) {
    return refuse(error.code === "not_found" ? "not_found" : error.code === "refused" ? "invalid" : "conflict", BB_PORT_TEXT[error.code]);
  }
  log(`${method}: BB call failed (${errorKind(error)})`);
  return refuse("conflict", BB_PORT_TEXT.failed);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function partBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array | null {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return null;
}

/** One line without control or invisible characters. */
function oneLine(text: string, max: number): string {
  const line = removeControls(removeInvisible(text.replace(/\s+/g, " "))).trim();
  return Array.from(line).slice(0, max).join("");
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/** In-flight keys: a second start for the same key refuses (spec resolution 13). */
export class InFlight {
  private readonly keys = new Set<string>();
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.keys.has(key)) throw refuse("conflict", BB_REFUSAL_TEXT.in_flight);
    this.keys.add(key);
    try {
      return await work();
    } finally {
      this.keys.delete(key);
    }
  }
}

/** The message and its body as the BB text builders read them. */
export function bbMessage(store: MailStore, header: MessageHeader): BbMessage {
  return { header, body: store.getBody(header.id) };
}

/** The bytes of a stored attachment, read from a fetched raw message, or why not. */
export type PartRead = { ok: true; bytes: Uint8Array; filename: string | null } | { ok: false; reason: string };

/**
 * One guarded raw fetch for a message, then its parts by the download
 * route's checks: the part at the stored index whose file name, MIME type
 * and size still match the stored metadata.
 */
export async function readParts(rawDeps: RawDeps, header: MessageHeader): Promise<(partId: string) => PartRead> {
  let raw: Uint8Array;
  try {
    raw = (await fetchRawGuarded(rawDeps, header.id)).raw;
  } catch (error) {
    if (error instanceof RawRefusal) throw refuse(error.code, error.message);
    throw error;
  }
  const parsed = await parseMail(raw);
  return (partId) => {
    const stored = header.attachments.find((a) => a.partId === partId);
    if (stored === undefined) return { ok: false, reason: UNKNOWN_ATTACHMENT_TEXT };
    const part = parsed.attachments[Number(partId) - 1];
    const bytes = part === undefined ? null : partBytes(part.content);
    if (
      part === undefined ||
      bytes === null ||
      (part.filename ?? null) !== stored.filename ||
      part.mimeType !== stored.mimeType ||
      bytes.byteLength !== stored.size
    ) {
      return { ok: false, reason: STALE_MESSAGE };
    }
    return { ok: true, bytes, filename: stored.filename };
  };
}

/** A conflict answer for one save. */
type Conflict = "ask" | "keep_both" | "replace";

/**
 * Writes one file create-only under `folder` (resolution 5): `ask` reports
 * an existing file, `keep_both` numbers the name "(2)" to "(99)" checking
 * `exists` each time, `replace` passes the sha the owner was shown.
 */
export async function writeIntoTree(
  projects: ProjectDirectory,
  tree: WorkingTree,
  folder: string,
  name: string,
  bytes: Uint8Array,
  onConflict: Conflict,
  replaceSha: string | null,
): Promise<{ outcome: "saved"; path: string; sizeBytes: number; sha256: string } | { outcome: "exists"; path: string; currentSha: string } | { outcome: "failed"; reason: string }> {
  for (let n = 1; n <= KEEP_BOTH_MAX; n++) {
    const candidate = n === 1 ? name : keepBothName(name, n);
    const placed = projectRelativePath(folder, candidate);
    if (!placed.ok) return { outcome: "failed", reason: PROJECT_PATH_REFUSAL_TEXT[placed.reason] };
    const path = placed.relativePath;
    try {
      if (onConflict === "keep_both" && (await projects.exists(tree, path)) !== null) continue;
      const written = await projects.write(tree, path, bytes, { replaceSha: onConflict === "replace" ? replaceSha : null });
      if (written.outcome === "written") return { outcome: "saved", path, sizeBytes: written.sizeBytes, sha256: written.sha256 };
      if (onConflict === "keep_both") continue;
      return { outcome: "exists", path, currentSha: written.currentSha };
    } catch (error) {
      if (error instanceof BbPortError) {
        if (error.code === "disabled") throw refuse("conflict", BB_REFUSAL_TEXT.save_disabled);
        return { outcome: "failed", reason: BB_PORT_TEXT[error.code] };
      }
      return { outcome: "failed", reason: BB_PORT_TEXT.failed };
    }
  }
  return { outcome: "failed", reason: NAME_TAKEN_TEXT };
}

/** "host/owner/repo" of a project's remote, lower case; null without one. */
export function projectRepo(project: Pick<ProjectInfo, "remote">): string | null {
  return project.remote === null ? null : `${project.remote.host}/${project.remote.path}`.toLowerCase();
}

/**
 * A binding rule's value as stored (resolution 14 and "Project binding"):
 * an address and a domain in lower case (the domain in ASCII), a normalized
 * List-Id, a repository as "host/owner/repo"; null when it is none of them.
 */
export function normalizeBinding(kind: BindingKind, raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  switch (kind) {
    case "address": {
      const address = value.toLowerCase();
      return ADDRESS.test(address) ? address : null;
    }
    case "domain": {
      const ascii = domainToASCII(value.replace(/^@/, "").replace(/\.$/, "").toLowerCase());
      return ascii !== "" && DOMAIN.test(ascii) ? ascii : null;
    }
    case "list":
      return normalizeListId(value);
    case "repo": {
      const ref = repoRefOf(value) ?? (/^[a-z][a-z0-9+.-]*:/i.test(value) ? null : repoRefOf(`https://${value}`));
      return ref === null ? null : `${ref.host}/${ref.path}`.toLowerCase();
    }
  }
}

/** The project a dev group or repo maps to: a repo binding rule first, else a project whose remote is that repo. */
function projectForRepo(
  repo: string | null,
  projects: readonly ProjectInfo[],
  bindings: readonly BindingRow[],
): { id: string; name: string | null } | null {
  if (repo === null) return null;
  const key = repo.toLowerCase();
  const bound = bindings.find((row) => row.kind === "repo" && row.value === key);
  if (bound !== undefined) return { id: bound.projectId, name: projects.find((p) => p.id === bound.projectId)?.name ?? null };
  const matched = projects.find((project) => projectRepo(project) === key);
  return matched === undefined ? null : { id: matched.id, name: matched.name };
}

function devCounts(counts: DevGroupRow["counts"]): Record<(typeof DEV_KINDS)[number], number> {
  return Object.fromEntries(DEV_KINDS.map((kind) => [kind, counts[kind] ?? 0])) as Record<(typeof DEV_KINDS)[number], number>;
}

/** An incident thread still takes updates (7 days since its last). */
function appendable(row: IncidentRow, now: Date): boolean {
  return now.getTime() - Date.parse(row.lastAt) <= INCIDENT_APPEND_DAYS * DAY_MS;
}

/** A rule's match as stored: addresses, domains (ASCII), the List-Id, words and the repo in lower case. */
export function normalizeRuleMatch(match: RuleMatch): RuleMatch {
  const out: RuleMatch = {};
  if (match.from !== undefined && match.from.length > 0) out.from = match.from.map((address) => address.trim().toLowerCase());
  if (match.domains !== undefined && match.domains.length > 0) {
    out.domains = match.domains.map((domain) => {
      const plain = domain.trim().replace(/^@/, "").toLowerCase();
      return domainToASCII(plain) || plain;
    });
  }
  if (match.list !== undefined && match.list !== null && match.list.trim() !== "") out.list = normalizeListId(match.list) ?? match.list.trim().toLowerCase();
  if (match.subjectWords !== undefined && match.subjectWords.length > 0) out.subjectWords = match.subjectWords.map((word) => word.trim().toLowerCase());
  if (match.dev !== undefined && match.dev !== null) {
    const dev: NonNullable<RuleMatch["dev"]> = {};
    if (match.dev.source !== undefined) dev.source = match.dev.source;
    if (match.dev.kind !== undefined) dev.kind = match.dev.kind;
    if (match.dev.state !== undefined) dev.state = match.dev.state;
    if (match.dev.repo !== undefined) dev.repo = match.dev.repo.trim().toLowerCase();
    out.dev = dev;
  }
  if (match.accounts !== undefined && match.accounts.length > 0) out.accounts = [...match.accounts];
  return out;
}

/** What rule evaluation needs (afterRoundRules). */
export type RuleDeps = {
  store: MailStore;
  clock: Clock;
  newId: () => string;
  projects: ProjectDirectory;
  threads: BbThreads;
  agentLog: (input: LogEntryInput) => number | null;
  log: (line: string) => void;
  /** The owner's mailRules setting. */
  mailRules: () => boolean;
  /** A run was prepared or started: the day clock announces it. */
  notify: () => void;
};

/**
 * Mail rules after an ok round (spec "Mail rules", resolutions 1, 3 and 13):
 * only with mailRules on; only newInbox minus returning (never backfill,
 * an initial sync or a reset); each row inside the AI access scope, not from
 * the owner, bulk only for dev or list rules; one run per rule and message.
 * Prepare-mode runs become ready. Start-mode runs are inserted as starting
 * with the caps in one transaction, then spawn in a managed worktree with
 * accept-edits (never the checkout); alert-class rules with an open incident
 * become ready ("Add to incident thread") instead. Logs ids and codes only.
 */
export async function afterRoundRules(
  deps: RuleDeps,
  accountId: string,
  outcome: { newInbox: readonly string[]; returning: readonly string[] },
): Promise<void> {
  if (!deps.mailRules()) return;
  const { store } = deps;
  const rules = store.listRules().filter((rule) => rule.enabled);
  if (rules.length === 0) return;
  const ids = ruleCandidates(outcome);
  if (ids.length === 0) return;
  const nowIso = deps.clock.now().toISOString();
  const rows = new Map(store.notifyRows(ids, nowIso).map((row) => [row.id, row]));
  const listIds = store.listIds(ids);
  const own = new Set(ownAddresses(store).map((address) => address.trim().toLowerCase()));
  let projects: ProjectInfo[] | null | undefined;
  const projectList = async () => {
    if (projects === undefined) {
      try {
        projects = await deps.projects.list();
      } catch {
        projects = null;
      }
    }
    return projects;
  };
  for (const id of ids) {
    const header = store.scopedMessage(id);
    const row = rows.get(id);
    // A row a block rule just queued to Spam is not judged.
    if (header === null || row === undefined || header.accountId !== accountId || row.movePending !== null) continue;
    if (own.has(header.from.address.trim().toLowerCase())) continue;
    const ruleRow = {
      accountId,
      fromAddress: header.from.address,
      listId: listIds.get(id) ?? null,
      subject: header.subject,
      dev: header.dev,
      bulk: isBulkRow(row.bulk, row.fromAddress),
    };
    for (const rule of rules) {
      if (!mailRuleMatches(rule, ruleRow)) continue;
      try {
        await runRule(deps, rule, header, projectList);
      } catch (error) {
        deps.log(`rule ${rule.id}: failed (${errorKind(error)})`);
      }
    }
  }
}

async function runRule(
  deps: RuleDeps,
  rule: Rule,
  header: MessageHeader,
  projectList: () => Promise<ProjectInfo[] | null>,
): Promise<void> {
  const { store } = deps;
  const nowIso = () => deps.clock.now().toISOString();
  const runId = `run_${deps.newId()}`;
  let state: "starting" | "ready" = rule.mode === "start" ? "starting" : "ready";
  let tree: WorkingTree | null = null;
  let alert: { parts: AlertParts; ref: string } | null = null;
  if (state === "starting") {
    // A project without a tree (or BB not answering) cannot start: the run waits for the owner.
    tree = (await projectList())?.find((project) => project.id === rule.projectId)?.tree ?? null;
    if (tree === null) state = "ready";
  }
  if (state === "starting" && alertClass(rule) && header.dev !== null && header.dev.source === "monitoring") {
    const parts = alertOf({ devClass: header.dev, subject: header.subject, text: bodyPlainText(store.getBody(header.id)) });
    if (parts !== null) {
      alert = { parts, ref: await alertFingerprint(parts) };
      const open = store.incidentFor(alert.ref);
      // An open incident takes the mail as an update the owner adds ("Add to incident thread").
      if (open !== null && appendable(open, deps.clock.now())) state = "ready";
    }
  }
  const inserted = store.insertRuleRun(
    { id: runId, ruleId: rule.id, accountId: header.accountId, messageId: header.id, threadId: header.threadId, state, createdAt: nowIso() },
    RULE_CAPS,
  );
  if (inserted === "duplicate") return;
  if (inserted === "capped") {
    deps.agentLog({ actor: "rule", tool: "rule_thread", outcome: "capped", messageIds: [header.id], refId: rule.id });
    return;
  }
  if (state === "ready") {
    deps.agentLog({ actor: "rule", tool: "rule_thread", outcome: "prepared", messageIds: [header.id], refId: rule.id });
    deps.notify();
    return;
  }
  let bbThreadId: string;
  let hidden = 0;
  try {
    const text = rulePrompt(rule, bbMessage(store, header));
    hidden = text.hidden;
    bbThreadId = (
      await deps.threads.spawn({
        projectId: rule.projectId,
        environment: worktreeEnvironment(tree!),
        title: threadTitle(header.subject, rule.name),
        prompt: text.text,
        pluginMetadata: metadataFor({
          accountId: header.accountId,
          messageId: header.id,
          threadId: header.threadId,
          kind: alert === null ? "rule" : "incident",
          origin: "rule",
          ruleId: rule.id,
        }),
        permissionMode: "accept-edits",
      })
    ).threadId;
  } catch (error) {
    // Never a second spawn and never the checkout: the owner may start it from the strip.
    store.updateRuleRun(runId, { state: "failed" }, nowIso());
    deps.agentLog({ actor: "rule", tool: "rule_thread", outcome: "failed", messageIds: [header.id], refId: rule.id });
    deps.log(`rule ${rule.id}: thread not started (${errorKind(error)})`);
    return;
  }
  const at = nowIso();
  store.updateRuleRun(runId, { state: "started", bbThreadId }, at);
  if (alert !== null) store.putIncident({ fingerprint: alert.ref, bbThreadId, projectId: rule.projectId, createdAt: at, lastAt: at });
  store.addBbLink({
    id: `bbl_${deps.newId()}`,
    accountId: header.accountId,
    messageId: header.id,
    threadId: header.threadId,
    kind: alert === null ? "thread" : "incident",
    targetId: bbThreadId,
    projectId: rule.projectId,
    extra: null,
    createdAt: at,
  });
  deps.agentLog({ actor: "rule", tool: "rule_thread", outcome: "started", messageIds: [header.id], count: 1, hiddenCount: hidden, refId: bbThreadId });
  deps.notify();
}

export function createBbRpc(deps: BbRpcDeps) {
  const { store, projects, threads, clock } = deps;
  const saveEnabled = deps.saveEnabled ?? SAVE_TO_PROJECT_ENABLED;
  const nowIso = () => clock.now().toISOString();
  const starts = new InFlight();
  let lastBoardId: string | null = null;

  function message(messageId: string): MessageHeader {
    const header = store.getMessage(messageId);
    if (header === null) throw refuse("not_found", UNKNOWN_MESSAGE_TEXT);
    return header;
  }

  async function projectList(method: string): Promise<ProjectInfo[]> {
    try {
      return await projects.list();
    } catch (error) {
      throw bbRefusal(error, deps.log, method);
    }
  }

  async function projectOf(projectId: string, method: string): Promise<ProjectInfo> {
    const project = (await projectList(method)).find((p) => p.id === projectId);
    if (project === undefined) throw refuse("not_found", UNKNOWN_PROJECT_TEXT);
    return project;
  }

  /** A folder setting, its default when it is no longer a valid folder. */
  function settingFolder(value: string, fallback: string): string {
    return projectFolder(value).ok ? value : fallback;
  }

  function link(row: Omit<BbLinkRow, "id" | "createdAt">): void {
    try {
      store.addBbLink({ ...row, id: `bbl_${deps.newId()}`, createdAt: nowIso() });
    } catch (error) {
      deps.log(`bb link not kept (${errorKind(error)})`);
    }
  }

  /**
   * The messages a thread starts with: the message, or its conversation
   * oldest first. Members outside the AI access scope are left out and
   * counted; the clicked message itself must be inside it.
   */
  function threadMessages(header: MessageHeader, include: "message" | "conversation"): { messages: BbMessage[]; skipped: number } {
    if (!header.inAiScope) throw new BbTextOutOfScope();
    if (include === "message") return { messages: [bbMessage(store, header)], skipped: 0 };
    const members = store.getThread(header.threadId, header.folder)?.messages ?? [header];
    const inScope = members.filter((member) => member.inAiScope);
    const list = inScope.some((member) => member.id === header.id) ? inScope : [...inScope, header];
    return { messages: list.map((member) => bbMessage(store, member)), skipped: members.length - inScope.length };
  }

  function buildThreadText(
    header: MessageHeader,
    input: { include: "message" | "conversation"; instruction?: string | undefined },
    savedPaths?: readonly string[],
  ) {
    const { messages, skipped } = threadMessages(header, input.include);
    const built = threadPrompt({
      instruction: input.instruction ?? "",
      messages,
      kind: input.include,
      ...(savedPaths === undefined || savedPaths.length === 0 ? {} : { savedPaths }),
    });
    return { ...built, leftOut: built.leftOut + skipped, title: threadTitle(header.subject) };
  }

  async function permissionMode(projectId: string): Promise<BbPermissionMode | null> {
    try {
      return await threads.defaultPermissionMode(projectId);
    } catch {
      return null;
    }
  }

  /** Saves parts of a message into a project (attachment_save and "Also save the attachments"). */
  async function saveParts(
    header: MessageHeader,
    partIds: readonly string[],
    project: ProjectInfo,
    folderInput: string | undefined,
    onConflict: Conflict,
    replaceSha: string | null,
  ): Promise<SaveResult[]> {
    if (!saveEnabled) throw refuse("conflict", BB_REFUSAL_TEXT.save_disabled);
    const tree = project.tree;
    if (tree === null) throw refuse("conflict", BB_REFUSAL_TEXT.no_tree);
    const settings = deps.settings();
    const folder = folderInput ?? settingFolder(settings.attachmentFolder, "mail-attachments");
    const checked = projectFolder(folder);
    if (!checked.ok) throw refuse("invalid", PROJECT_PATH_REFUSAL_TEXT[checked.reason]);
    if (onConflict === "replace" && replaceSha === null) throw refuse("invalid", REPLACE_NEEDS_SHA_TEXT);
    const ids = [...new Set(partIds)];
    if (ids.length === 0) throw refuse("invalid", NO_ATTACHMENTS_TEXT);
    const read = await readParts(deps.rawDeps, header);
    const results: SaveResult[] = [];
    let total = 0;
    for (const partId of ids) {
      const part = read(partId);
      if (!part.ok) {
        results.push({ partId, outcome: "failed", reason: part.reason });
        continue;
      }
      if (part.bytes.byteLength > SAVE_PART_MAX_BYTES) {
        results.push({ partId, outcome: "failed", reason: FILE_TOO_LARGE_TEXT });
        continue;
      }
      if (total + part.bytes.byteLength > SAVE_CALL_MAX_BYTES) {
        results.push({ partId, outcome: "failed", reason: SAVE_TOO_LARGE_TEXT });
        continue;
      }
      total += part.bytes.byteLength;
      const written = await writeIntoTree(projects, tree, folder, savedName(part.filename), part.bytes, onConflict, replaceSha);
      if (written.outcome === "saved") {
        link({
          accountId: header.accountId,
          messageId: header.id,
          threadId: header.threadId,
          kind: "project_file",
          targetId: written.path,
          projectId: project.id,
          extra: written.sha256,
        });
        results.push({ partId, outcome: "saved", path: written.path, sizeBytes: written.sizeBytes });
      } else if (written.outcome === "exists") {
        results.push({ partId, outcome: "exists", path: written.path, currentSha: written.currentSha });
      } else {
        results.push({ partId, outcome: "failed", reason: written.reason });
      }
    }
    const saved = results.filter((result) => result.outcome === "saved").length;
    deps.agentLog({
      actor: "owner_bb",
      tool: "project_save",
      outcome: saved > 0 ? "ok" : "failed",
      messageIds: [header.id],
      count: saved,
    });
    return results;
  }

  // ---- Projects ----

  async function projectsList() {
    const list = await projectList("projects_list");
    return {
      projects: list.map((project) => ({
        id: project.id,
        name: project.name,
        kind: project.kind,
        hasTree: project.tree !== null,
        repo: project.remote === null ? null : `${project.remote.host}/${project.remote.path}`,
      })),
    };
  }

  // ---- Mail to a BB thread ----

  async function threadPrepare(input: { messageId: string; include: "message" | "conversation"; projectId: string; instruction?: string | undefined }) {
    const header = message(input.messageId);
    await projectOf(input.projectId, "bb_thread_prepare");
    let built;
    try {
      built = buildThreadText(header, input);
    } catch (error) {
      throw bbRefusal(error, deps.log, "bb_thread_prepare");
    }
    return {
      prompt: built.text,
      title: built.title,
      hidden: built.hidden,
      leftOut: built.leftOut,
      permissionMode: await permissionMode(input.projectId),
    };
  }

  async function threadStart(input: {
    messageId: string;
    include: "message" | "conversation";
    projectId: string;
    instruction?: string | undefined;
    saveAttachments?: boolean | undefined;
    ruleRunId?: string | undefined;
  }) {
    const header = message(input.messageId);
    if (!header.inAiScope) {
      deps.agentLog({ actor: "owner_bb", tool: "bb_thread", outcome: "refused_scope", messageIds: [header.id] });
      throw refuse("conflict", BB_REFUSAL_TEXT.out_of_scope);
    }
    const run = input.ruleRunId === undefined ? null : store.getRuleRun(input.ruleRunId);
    if (input.ruleRunId !== undefined && (run === null || run.messageId !== header.id || (run.state !== "ready" && run.state !== "failed"))) {
      throw refuse("not_found", UNKNOWN_RULE_RUN_TEXT);
    }
    return starts.run(header.id, async () => {
      const project = await projectOf(input.projectId, "bb_thread_start");
      let saved: SaveResult[] | undefined;
      if (input.saveAttachments === true) {
        const parts = header.attachments.filter((a) => !a.isInline).slice(0, START_SAVE_PARTS_MAX).map((a) => a.partId);
        saved = parts.length === 0 ? [] : await saveParts(header, parts, project, undefined, "keep_both", null);
      }
      const savedPaths = (saved ?? []).flatMap((result) => (result.outcome === "saved" ? [result.path] : []));
      let built;
      try {
        built = buildThreadText(header, input, savedPaths);
      } catch (error) {
        throw bbRefusal(error, deps.log, "bb_thread_start");
      }
      let bbThreadId: string;
      try {
        bbThreadId = (
          await threads.spawn({
            projectId: project.id,
            environment: projectDefaultEnvironment(),
            title: built.title,
            prompt: built.text,
            pluginMetadata: metadataFor({ accountId: header.accountId, messageId: header.id, threadId: header.threadId, kind: "thread" }),
          })
        ).threadId;
      } catch (error) {
        deps.agentLog({ actor: "owner_bb", tool: "bb_thread", outcome: "failed", messageIds: built.messageIds });
        throw bbRefusal(error, deps.log, "bb_thread_start");
      }
      link({
        accountId: header.accountId,
        messageId: header.id,
        threadId: header.threadId,
        kind: "thread",
        targetId: bbThreadId,
        projectId: project.id,
        extra: null,
      });
      if (run !== null) store.updateRuleRun(run.id, { state: "started", bbThreadId }, nowIso());
      deps.agentLog({
        actor: "owner_bb",
        tool: "bb_thread",
        outcome: "ok",
        messageIds: built.messageIds,
        count: built.messageIds.length,
        hiddenCount: built.hidden,
        refId: bbThreadId,
      });
      return saved === undefined ? { bbThreadId } : { bbThreadId, saved };
    });
  }

  async function threadsRecent(input: { projectId: string; limit: number }) {
    let listed;
    try {
      listed = await threads.list({ projectId: input.projectId, limit: input.limit });
    } catch (error) {
      throw bbRefusal(error, deps.log, "bb_threads_recent");
    }
    return {
      threads: listed
        .filter((thread) => !thread.archived)
        .map((thread) => ({ id: thread.id, title: thread.title ?? "", updatedAt: thread.updatedAt })),
    };
  }

  // ---- Mail to a task ----

  async function taskTargets() {
    const target = deps.settings().taskTarget;
    if (target === "local") return { taskboard: null, reason: null, lastBoardId, target };
    const boards = await deps.tasks.boards();
    if ("unavailable" in boards) return { taskboard: null, reason: boards.unavailable, lastBoardId, target };
    return { taskboard: { boards: boards.boards }, reason: null, lastBoardId, target };
  }

  async function taskFromMail(input: {
    messageId: string;
    target: { kind: "taskboard"; boardId: string } | { kind: "local"; due?: string | null | undefined };
    title: string;
    note?: string | undefined;
    excerpt: boolean;
  }) {
    const header = message(input.messageId);
    const common = {
      subject: header.subject,
      title: input.title,
      ...(input.note === undefined ? {} : { note: input.note }),
      sender: header.from,
      date: header.date,
      inAiScope: header.inAiScope,
      excerpt: input.excerpt ? bbMessage(store, header) : null,
    };
    if (input.target.kind === "taskboard") {
      let text;
      try {
        text = taskText({ ...common, target: "taskboard" });
      } catch (error) {
        if (error instanceof BbTextOutOfScope) {
          deps.agentLog({ actor: "owner_bb", tool: "bb_task", outcome: "refused_scope", messageIds: [header.id] });
        }
        throw bbRefusal(error, deps.log, "task_from_mail");
      }
      const boardId = input.target.boardId;
      const created = await deps.tasks.create(boardId, text.title, text.description);
      if ("unavailable" in created) {
        deps.agentLog({ actor: "owner_bb", tool: "bb_task", outcome: "failed", messageIds: [header.id] });
        return { kind: "unavailable" as const, reason: created.unavailable };
      }
      if ("refused" in created) {
        deps.agentLog({ actor: "owner_bb", tool: "bb_task", outcome: "refused_invalid", messageIds: [header.id] });
        throw refuse("conflict", `Taskboard: ${created.refused}`);
      }
      lastBoardId = boardId;
      link({
        accountId: header.accountId,
        messageId: header.id,
        threadId: header.threadId,
        kind: "taskboard_task",
        targetId: created.taskId,
        projectId: null,
        extra: boardId,
      });
      deps.agentLog({
        actor: "owner_bb",
        tool: "bb_task",
        outcome: "ok",
        messageIds: [header.id],
        count: 1,
        hiddenCount: text.hidden,
        refId: created.taskId,
      });
      return { kind: "taskboard" as const, taskId: created.taskId };
    }
    const text = taskText({ ...common, target: "local" });
    const row = store.notifyRows([header.id], nowIso())[0];
    if (row === undefined) throw refuse("not_found", UNKNOWN_MESSAGE_TEXT);
    const id = `task_${deps.newId()}`;
    const kept = store.keepTasks([
      {
        id,
        accountId: header.accountId,
        messageId: header.id,
        dedupKey: row.dedupKey,
        title: text.title,
        due: input.target.due ?? null,
        createdAt: nowIso(),
        note: text.description,
      },
    ]);
    if ("full" in kept) throw refuse("conflict", "You have the most open tasks Makosh Mail keeps; finish or delete some first");
    return { kind: "local" as const, taskId: id };
  }

  // ---- Attachments into a project ----

  async function attachmentSave(input: {
    messageId: string;
    partIds: string[];
    projectId: string;
    folder?: string | undefined;
    onConflict: Conflict;
    replaceSha?: string | undefined;
  }) {
    const header = message(input.messageId);
    if (!saveEnabled) throw refuse("conflict", BB_REFUSAL_TEXT.save_disabled);
    const project = await projectOf(input.projectId, "attachment_save");
    // An attachment of mail outside the AI access scope is the owner's file: it may be saved.
    const results = await saveParts(header, input.partIds, project, input.folder, input.onConflict, input.replaceSha ?? null);
    return { results };
  }

  // ---- BB files as draft attachments ----

  async function projectFiles(input: { projectId: string; query: string; limit: number }) {
    try {
      return await projects.files(input.projectId, input.query, input.limit);
    } catch (error) {
      throw bbRefusal(error, deps.log, "project_files");
    }
  }

  async function projectFolders(input: { projectId: string; query: string; limit: number }) {
    try {
      return await projects.folders(input.projectId, input.query, input.limit);
    } catch (error) {
      throw bbRefusal(error, deps.log, "project_folders");
    }
  }

  async function threadFiles(input: { bbThreadId: string; query?: string | undefined; limit: number }) {
    try {
      return await threads.storageFiles(input.bbThreadId, input.query ?? "", input.limit);
    } catch (error) {
      throw bbRefusal(error, deps.log, "thread_files");
    }
  }

  async function composeAttachBb(input: {
    draftId: string;
    source: { kind: "project"; projectId: string; path: string } | { kind: "thread"; bbThreadId: string; path: string };
    confirmed?: boolean | undefined;
  }) {
    const draft = deps.ownerDraft(input.draftId);
    if (isQueued(store, draft)) throw new ComposeError("queued");
    const path = input.source.path;
    if (underGit(path)) throw refuse("invalid", GIT_FILE_TEXT);
    const fileName = sanitizeFileName(baseName(path), "attachment");
    if (sensitiveName(fileName) && input.confirmed !== true) throw refuse("conflict", BB_REFUSAL_TEXT.confirm_needed);
    let file;
    try {
      file =
        input.source.kind === "project"
          ? await projects.fileContent(input.source.projectId, path)
          : await threads.readStorageFile(input.source.bbThreadId, path);
    } catch (error) {
      throw bbRefusal(error, deps.log, "compose_attach_bb");
    }
    if (file.bytes.byteLength > BB_ATTACH_MAX_BYTES) throw refuse("invalid", FILE_TOO_LARGE_TEXT);
    if (file.bytes.byteLength > attachmentRoom(store, draft.id)) throw refuse("invalid", DRAFT_ROOM_TEXT);
    const origin = input.source.kind === "project" ? `bb:project:${input.source.projectId}` : `bb:thread:${input.source.bbThreadId}`;
    // The host's type is untrusted: only an inert type is kept.
    return addComposeAttachment(store, draft.id, {
      fileName,
      mimeType: safeContentType(file.mimeType ?? "application/octet-stream"),
      size: file.bytes.byteLength,
      sha256: sha256Hex(file.bytes),
      data: file.bytes,
      origin,
    });
  }

  // ---- A thread's result as a draft ----

  /** The account a new draft uses: the last one sent from, else the first. */
  function defaultAccount(): string {
    const accounts = store.listAccounts();
    const known = new Set(accounts.map((account) => account.id));
    const last = store
      .listOutbox(null)
      .filter((row) => known.has(row.accountId))
      .sort((a, b) => (a.sendAfter < b.sendAfter ? 1 : -1))[0];
    const accountId = last?.accountId ?? accounts[0]?.id;
    if (accountId === undefined) throw refuse("conflict", "Connect a mail account first");
    return accountId;
  }

  /** The stored message Mail's own links tie this BB thread to (resolution 4), or null. */
  function originMessage(bbThreadId: string): MessageHeader | null {
    const links = store.listBbLinks({ targetId: bbThreadId }).filter((row) => row.kind === "thread" || row.kind === "incident" || row.kind === "patch");
    for (const row of [...links].reverse()) {
      const header = store.getMessage(row.messageId);
      if (header !== null) return header;
    }
    return null;
  }

  async function draftFromBb(input: { bbThreadId: string; source: { kind: "output" } | { kind: "message"; text: string } }) {
    let text: string;
    if (input.source.kind === "output") {
      let output: string | null;
      try {
        output = await threads.output(input.bbThreadId);
      } catch (error) {
        throw bbRefusal(error, deps.log, "draft_from_bb");
      }
      if (output === null || output.trim() === "") throw refuse("conflict", BB_REFUSAL_TEXT.no_result);
      text = output;
    } else {
      text = input.source.text;
    }
    text = text.slice(0, MARKDOWN_INPUT_MAX);
    const origin = originMessage(input.bbThreadId);
    let draftId: string;
    let subject: string | null = null;
    if (origin !== null) {
      draftId = (await prepareCompose(deps.composeDeps, { kind: "reply", messageId: origin.id })).draftId;
    } else {
      draftId = newCompose(deps.composeDeps, defaultAccount()).draftId;
      try {
        const [thread] = await threads.list({ threadIds: [input.bbThreadId] });
        subject = thread?.title === undefined || thread.title === null ? null : oneLine(thread.title, DRAFT_SUBJECT_MAX);
      } catch {
        subject = null;
      }
    }
    const draft = store.getDraft(draftId);
    if (draft === null) throw new ComposeError("not_found");
    const body = markdownToDoc(text);
    const doc = normalizeDoc({ type: "doc", content: [...body.content, ...(draft.doc as ComposeDoc).content] } as Parameters<typeof normalizeDoc>[0]);
    const saved = store.saveDraft(
      draftId,
      draft.revision,
      {
        accountId: draft.accountId,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: subject ?? draft.subject,
        doc,
        fromAddress: draft.fromAddress,
      },
      nowIso(),
    );
    if ("conflict" in saved) throw new ComposeError("conflict");
    return { draftId, accountId: draft.accountId, reply: origin !== null };
  }

  // ---- The reading pane's links ----

  /**
   * thread_get's BB links with BB thread titles (threads.list); archived and
   * deleted threads hidden, deleted ones pruned. When BB does not answer the
   * links stay as stored, without titles.
   */
  async function withBbLinks(detail: ThreadDetail): Promise<ThreadDetail> {
    const threadKinds = new Set(["thread", "incident", "patch"]);
    const ids = new Set<string>();
    for (const header of detail.messages) {
      for (const row of header.bbLinks) if (threadKinds.has(row.kind) && !row.targetId.includes("/")) ids.add(row.targetId);
    }
    if (ids.size === 0) return detail;
    let found: Map<string, { title: string | null; archived: boolean }>;
    try {
      found = new Map((await threads.list({ threadIds: [...ids] })).map((thread) => [thread.id, { title: thread.title, archived: thread.archived }]));
    } catch {
      return detail;
    }
    const gone = [...ids].filter((id) => !found.has(id));
    if (gone.length > 0) {
      try {
        for (const kind of ["thread", "incident", "patch"] as const) store.pruneBbLinks(kind, gone);
      } catch (error) {
        deps.log(`bb links not pruned (${errorKind(error)})`);
      }
    }
    return {
      ...detail,
      messages: detail.messages.map((header) => ({
        ...header,
        bbLinks: header.bbLinks.flatMap((row) => {
          if (!threadKinds.has(row.kind) || !ids.has(row.targetId)) return [row];
          const thread = found.get(row.targetId);
          if (thread === undefined || thread.archived) return [];
          return [{ ...row, title: thread.title }];
        }),
      })),
    };
  }


  // ---- Dev mail (Task 11) ----

  async function listOrNull(): Promise<ProjectInfo[] | null> {
    try {
      return await projects.list();
    } catch {
      return null;
    }
  }

  async function devDigest(input: { days?: number | undefined; accountId?: string | undefined; cursor?: string | null | undefined }) {
    const since = new Date(clock.now().getTime() - (input.days ?? DEV_DIGEST_DAYS) * DAY_MS).toISOString();
    const page = store.devGroups({ sinceIso: since, accountId: input.accountId ?? null, cursor: input.cursor ?? null, limit: DEV_DIGEST_PAGE });
    const list = (await listOrNull()) ?? [];
    const bindings = store.listBindings();
    return {
      groups: page.groups.map((group) => {
        const project = group.source === "github" || group.source === "gitlab" ? projectForRepo(group.repo, list, bindings) : null;
        return {
          source: group.source,
          repo: group.repo,
          counts: devCounts(group.counts),
          ciFailed: group.ciFailed,
          latestFailure: group.latestFailure,
          unread: group.unread,
          total: group.total,
          latestDate: group.latestDate,
          messageIds: group.messageIds,
          projectId: project?.id ?? null,
          projectName: project?.name ?? null,
        };
      }),
      next: page.next,
    };
  }

  /** Today's dev line: the last 24 hours. */
  function todayDev(): { ciFailed: number; repos: number; alertsFiring: number } {
    if (!deps.settings().devNotifications) return { ciFailed: 0, repos: 0, alertsFiring: 0 };
    const since = new Date(clock.now().getTime() - DAY_MS).toISOString();
    const { groups } = store.devGroups({ sinceIso: since, limit: TODAY_DEV_GROUPS });
    return {
      ciFailed: groups.reduce((sum, group) => sum + group.ciFailed, 0),
      repos: groups.filter((group) => group.source !== "monitoring" && group.repo !== null).length,
      alertsFiring: groups.reduce((sum, group) => sum + group.firing, 0),
    };
  }

  /** The text and hrefs links are read from: the plain body, else the HTML's text. */
  function linkSource(header: MessageHeader): { text: string; hrefs: string[]; plain: string } {
    const body = store.getBody(header.id);
    if (body === null) return { text: "", hrefs: [], plain: "" };
    const scan = body.html === null ? null : scanHtml(body.html);
    const text = body.text !== null && body.text.trim() !== "" ? body.text : (scan?.text ?? "");
    return { text, hrefs: scan?.hrefs ?? [], plain: bodyPlainText(body) };
  }

  /**
   * thread_get's 3g fields: BB links (withBbLinks), dev links mapped to
   * projects, the patch summary, the alert flag, the bound project (the
   * owner's chip, else a binding rule) and, when none is bound, a suggestion
   * from the links or the dev repo that never binds by itself.
   */
  async function threadDetail(detail: ThreadDetail): Promise<ThreadDetail> {
    const linked = await withBbLinks(detail);
    const list = await listOrNull();
    const remotes: ProjectRemote[] = (list ?? []).flatMap((project) => (project.remote === null ? [] : [{ projectId: project.id, remote: project.remote }]));
    const messages = linked.messages.map((header) => {
      const source = linkSource(header);
      const fromBody = patchFromBody(source.plain);
      let patch: MessageHeader["patch"] = null;
      if (fromBody !== null) {
        const parsed = parsePatch(fromBody);
        patch = {
          files: parsed.files.length,
          added: parsed.files.reduce((sum, file) => sum + file.added, 0),
          removed: parsed.files.reduce((sum, file) => sum + file.removed, 0),
        };
      } else if (header.attachments.some((part) => !part.isInline && isPatchAttachment(part))) {
        // Counted when the owner opens it (patch_view fetches the attachment).
        patch = { files: 0, added: 0, removed: 0 };
      }
      return { ...header, devLinks: devLinks(source.text, source.hrefs, remotes), patch, alert: header.dev?.source === "monitoring" };
    });
    const owned = store.conversationProject(detail.thread.accountId, detail.thread.id);
    const boundId = owned ?? detail.thread.projectId;
    const nameOf = (id: string) => list?.find((project) => project.id === id)?.name ?? (list === null ? id : REMOVED_PROJECT_NAME);
    const project = boundId === null ? null : { id: boundId, name: nameOf(boundId), source: owned !== null ? ("owner" as const) : ("rule" as const) };
    let projectSuggestion: ThreadDetail["projectSuggestion"] = null;
    if (project === null && list !== null) {
      for (const header of messages) {
        const viaLink = header.devLinks.find((devLink) => devLink.projectId !== null);
        const target = viaLink !== undefined ? list.find((p) => p.id === viaLink.projectId) : undefined;
        const viaRepo = target === undefined ? projectForRepo(header.dev?.repo ?? null, list, []) : null;
        const chosen = target ?? (viaRepo === null ? undefined : list.find((p) => p.id === viaRepo.id));
        if (chosen !== undefined) {
          projectSuggestion = { id: chosen.id, name: chosen.name, repo: projectRepo(chosen) };
          break;
        }
      }
    }
    return { ...linked, messages, project, projectSuggestion };
  }

  // ---- Patches (Task 11) ----

  async function patchSource(header: MessageHeader, partId: string | undefined): Promise<{ bytes: Uint8Array; text: string }> {
    if (partId !== undefined) {
      const stored = header.attachments.find((part) => part.partId === partId);
      if (stored === undefined) throw refuse("not_found", UNKNOWN_ATTACHMENT_TEXT);
      if (stored.size > PATCH_MAX_BYTES) throw refuse("invalid", PATCH_TOO_LARGE_TEXT);
      const read = (await readParts(deps.rawDeps, header))(partId);
      if (!read.ok) throw refuse("conflict", read.reason);
      return { bytes: read.bytes, text: new TextDecoder().decode(read.bytes) };
    }
    const text = patchFromBody(bodyPlainText(store.getBody(header.id)));
    if (text === null) throw refuse("not_found", NO_PATCH_TEXT);
    return { bytes: new TextEncoder().encode(text), text };
  }

  async function patchView(input: { messageId: string; partId?: string | undefined }) {
    const header = message(input.messageId);
    const source = await patchSource(header, input.partId);
    const parsed = parsePatch(source.text);
    return {
      files: parsed.files.slice(0, PATCH_FILES_MAX),
      warnings: parsed.warnings,
      refused: parsed.refused,
      commitMessage: parsed.commitMessage === null ? null : redactSecrets(parsed.commitMessage).text,
      patchRef: await patchRef(source.bytes),
    };
  }

  /** Fresh bytes, the reference the owner was shown checked again, refused patches refused. */
  async function checkedPatch(header: MessageHeader, partId: string | undefined, shown: string) {
    const source = await patchSource(header, partId);
    if ((await patchRef(source.bytes)) !== shown) throw refuse("conflict", PATCH_CHANGED_TEXT);
    const parsed = parsePatch(source.text);
    if (parsed.refused !== null) throw refuse("invalid", parsed.refused);
    return { ...source, parsed };
  }

  async function patchSave(input: { messageId: string; partId?: string | undefined; projectId: string; patchRef: string }) {
    const header = message(input.messageId);
    if (!saveEnabled) throw refuse("conflict", BB_REFUSAL_TEXT.save_disabled);
    const project = await projectOf(input.projectId, "patch_save");
    if (project.tree === null) throw refuse("conflict", BB_REFUSAL_TEXT.no_tree);
    const patch = await checkedPatch(header, input.partId, input.patchRef);
    const folder = settingFolder(deps.settings().patchFolder, "mail-patches");
    // The bytes as they came: Mail never rewrites a patch.
    const written = await writeIntoTree(projects, project.tree, folder, patchFileName(header.date, header.agentSubject), patch.bytes, "keep_both", null);
    if (written.outcome !== "saved") {
      deps.agentLog({ actor: "owner_bb", tool: "project_save", outcome: "failed", messageIds: [header.id] });
      throw refuse("conflict", written.outcome === "failed" ? written.reason : NAME_TAKEN_TEXT);
    }
    link({ accountId: header.accountId, messageId: header.id, threadId: header.threadId, kind: "patch", targetId: written.path, projectId: project.id, extra: input.patchRef });
    deps.agentLog({ actor: "owner_bb", tool: "project_save", outcome: "ok", messageIds: [header.id], count: 1 });
    return { path: written.path };
  }

  /**
   * Hands a patch to an agent (resolution 10): uploaded as a thread
   * attachment, never written into the tree, in a fresh managed worktree;
   * the checkout only when the owner chose it after a worktree refusal.
   */
  async function patchHandoff(input: {
    messageId: string;
    partId?: string | undefined;
    projectId: string;
    patchRef: string;
    environment?: "worktree" | "checkout" | undefined;
  }) {
    const header = message(input.messageId);
    if (!header.inAiScope) {
      deps.agentLog({ actor: "owner_bb", tool: "patch_handoff", outcome: "refused_scope", messageIds: [header.id] });
      throw refuse("conflict", BB_REFUSAL_TEXT.out_of_scope);
    }
    const project = await projectOf(input.projectId, "patch_handoff");
    const where: "worktree" | "checkout" = input.environment === "checkout" ? "checkout" : "worktree";
    if (where === "worktree" && project.tree === null) throw refuse("conflict", BB_REFUSAL_TEXT.no_tree);
    const patch = await checkedPatch(header, input.partId, input.patchRef);
    return starts.run(header.id, async () => {
      const prompt = patchPrompt(patch.parsed.commitMessage);
      let bbThreadId: string;
      try {
        const item = await threads.uploadAttachment(project.id, patch.bytes, patchFileName(header.date, header.agentSubject), "text/x-patch");
        bbThreadId = (
          await threads.spawn({
            projectId: project.id,
            environment: where === "checkout" || project.tree === null ? projectDefaultEnvironment() : worktreeEnvironment(project.tree),
            title: threadTitle(header.subject, "Apply patch"),
            prompt: prompt.text,
            extraInput: [item],
            pluginMetadata: metadataFor({ accountId: header.accountId, messageId: header.id, threadId: header.threadId, kind: "patch" }),
          })
        ).threadId;
      } catch (error) {
        deps.agentLog({ actor: "owner_bb", tool: "patch_handoff", outcome: "failed", messageIds: [header.id] });
        throw bbRefusal(error, deps.log, "patch_handoff");
      }
      link({ accountId: header.accountId, messageId: header.id, threadId: header.threadId, kind: "patch", targetId: bbThreadId, projectId: project.id, extra: input.patchRef });
      deps.agentLog({
        actor: "owner_bb",
        tool: "patch_handoff",
        outcome: "ok",
        messageIds: [header.id],
        count: 1,
        hiddenCount: prompt.hidden,
        refId: bbThreadId,
      });
      return { bbThreadId, environment: where };
    });
  }

  // ---- Alerts and incident threads (Task 11) ----

  async function alertOfMessage(header: MessageHeader): Promise<{ parts: AlertParts; ref: string } | null> {
    if (header.dev === null || header.dev.source !== "monitoring") return null;
    const parts = alertOf({ devClass: header.dev, subject: header.subject, text: bodyPlainText(store.getBody(header.id)) });
    return parts === null ? null : { parts, ref: await alertFingerprint(parts) };
  }

  /** The incident thread as BB knows it now, or null when BB does not answer or it is gone. */
  async function incidentThread(bbThreadId: string): Promise<{ title: string | null; archived: boolean } | null | "unknown"> {
    try {
      const [thread] = await threads.list({ threadIds: [bbThreadId] });
      return thread === undefined ? null : { title: thread.title, archived: thread.archived };
    } catch {
      return "unknown";
    }
  }

  async function alertView(input: { messageId: string }) {
    const header = message(input.messageId);
    const alert = await alertOfMessage(header);
    if (alert === null) return { alert: null, incident: null };
    const row = store.incidentFor(alert.ref);
    let incident = null;
    if (row !== null) {
      const thread = await incidentThread(row.bbThreadId);
      const live = thread !== null && thread !== "unknown" && !thread.archived;
      incident = {
        bbThreadId: row.bbThreadId,
        title: thread === null || thread === "unknown" ? null : thread.title,
        canAppend: live && appendable(row, clock.now()),
      };
    }
    return { alert: { ...alert.parts, alertRef: alert.ref }, incident };
  }

  function scopedAlertMessage(messageId: string): MessageHeader {
    const header = message(messageId);
    if (!header.inAiScope) {
      deps.agentLog({ actor: "owner_bb", tool: "incident", outcome: "refused_scope", messageIds: [header.id] });
      throw refuse("conflict", BB_REFUSAL_TEXT.out_of_scope);
    }
    return header;
  }

  async function incidentStart(input: { messageId: string; projectId: string; instruction?: string | undefined }) {
    const header = scopedAlertMessage(input.messageId);
    const alert = await alertOfMessage(header);
    if (alert === null) throw refuse("invalid", NOT_ALERT_TEXT);
    const project = await projectOf(input.projectId, "incident_start");
    return starts.run(`incident:${alert.ref}`, async () => {
      const open = store.incidentFor(alert.ref);
      if (open !== null && appendable(open, clock.now())) {
        const thread = await incidentThread(open.bbThreadId);
        if (thread !== null && (thread === "unknown" || !thread.archived)) throw refuse("conflict", INCIDENT_OPEN_TEXT);
      }
      let text;
      try {
        text = incidentPrompt(alert.parts, bbMessage(store, header), input.instruction);
      } catch (error) {
        throw bbRefusal(error, deps.log, "incident_start");
      }
      let bbThreadId: string;
      try {
        bbThreadId = (
          await threads.spawn({
            projectId: project.id,
            environment: projectDefaultEnvironment(),
            title: incidentTitle(alert.parts),
            prompt: text.text,
            pluginMetadata: metadataFor({ accountId: header.accountId, messageId: header.id, threadId: header.threadId, kind: "incident" }),
          })
        ).threadId;
      } catch (error) {
        deps.agentLog({ actor: "owner_bb", tool: "incident", outcome: "failed", messageIds: [header.id] });
        throw bbRefusal(error, deps.log, "incident_start");
      }
      const at = nowIso();
      store.putIncident({ fingerprint: alert.ref, bbThreadId, projectId: project.id, createdAt: at, lastAt: at });
      link({ accountId: header.accountId, messageId: header.id, threadId: header.threadId, kind: "incident", targetId: bbThreadId, projectId: project.id, extra: null });
      deps.agentLog({ actor: "owner_bb", tool: "incident", outcome: "ok", messageIds: [header.id], count: 1, hiddenCount: text.hidden, refId: bbThreadId });
      return { bbThreadId };
    });
  }

  async function incidentAppend(input: { messageId: string }) {
    const header = scopedAlertMessage(input.messageId);
    const alert = await alertOfMessage(header);
    if (alert === null) throw refuse("invalid", NOT_ALERT_TEXT);
    const row = store.incidentFor(alert.ref);
    if (row === null) throw refuse("not_found", NO_INCIDENT_TEXT);
    if (!appendable(row, clock.now())) throw refuse("conflict", INCIDENT_OLD_TEXT);
    const thread = await incidentThread(row.bbThreadId);
    if (thread === "unknown") throw refuse("conflict", BB_PORT_TEXT.failed);
    if (thread === null || thread.archived) throw refuse("conflict", INCIDENT_GONE_TEXT);
    let text;
    try {
      text = incidentUpdate(alert.parts, bbMessage(store, header));
      // Queued when the thread is running: an update never interrupts a turn.
      await threads.send(row.bbThreadId, text.text);
    } catch (error) {
      deps.agentLog({ actor: "owner_bb", tool: "incident", outcome: "failed", messageIds: [header.id] });
      throw bbRefusal(error, deps.log, "incident_append");
    }
    store.touchIncident(alert.ref, nowIso());
    link({ accountId: header.accountId, messageId: header.id, threadId: header.threadId, kind: "incident", targetId: row.bbThreadId, projectId: row.projectId, extra: null });
    deps.agentLog({ actor: "owner_bb", tool: "incident", outcome: "ok", messageIds: [header.id], count: 1, hiddenCount: text.hidden, refId: row.bbThreadId });
    return { bbThreadId: row.bbThreadId };
  }

  // ---- Project binding (Task 11) ----

  async function conversationProjectSet(input: { accountId: string; threadId: string; projectId: string | null }) {
    if (store.getAccount(input.accountId) === null) throw refuse("not_found", "Unknown account");
    if (input.projectId !== null) await projectOf(input.projectId, "conversation_project_set");
    store.setConversationProject(input.accountId, input.threadId, input.projectId, nowIso());
    deps.publishChanged(input.accountId);
    return { ok: true as const };
  }

  async function bindingAdd(input: { kind: BindingKind; value: string; projectId: string }) {
    const value = normalizeBinding(input.kind, input.value);
    if (value === null) throw refuse("invalid", BINDING_INVALID_TEXT[input.kind]);
    await projectOf(input.projectId, "binding_add");
    const added = store.addBinding({ kind: input.kind, value, projectId: input.projectId, createdAt: nowIso() });
    if ("full" in added) throw refuse("conflict", BINDINGS_FULL_TEXT);
    deps.publishChanged(null);
    return { ok: true as const };
  }

  function bindingRemove(input: { kind: BindingKind; value: string }) {
    const value = normalizeBinding(input.kind, input.value) ?? input.value.trim().toLowerCase();
    if (!store.removeBinding(input.kind, value)) throw refuse("not_found", UNKNOWN_BINDING_TEXT);
    deps.publishChanged(null);
    return { ok: true as const };
  }

  async function bindingsList() {
    const list = await listOrNull();
    return {
      bindings: store.listBindings().slice(0, BINDINGS_MAX).map((row) => {
        const project = list?.find((p) => p.id === row.projectId);
        return {
          kind: row.kind,
          value: row.value,
          projectId: row.projectId,
          projectName: project?.name ?? null,
          removed: list !== null && project === undefined,
          createdAt: row.createdAt,
        };
      }),
    };
  }

  function projectMail(input: { projectId: string; cursor?: string | null | undefined }) {
    const page = store.projectThreads(input.projectId, { cursor: input.cursor ?? null, limit: PROJECT_MAIL_PAGE });
    return { threads: page.threads, next: page.nextCursor };
  }

  /** The thread Info section (resolution 17): the project's latest bound conversations and those Mail's links tie the thread to. */
  function bbThreadMail(input: { projectId: string; bbThreadId: string }) {
    const bound = store.projectThreads(input.projectId, { cursor: null, limit: INFO_THREADS }).threads;
    const seen = new Set<string>();
    const origin: ThreadDetail["thread"][] = [];
    const links = store.listBbLinks({ targetId: input.bbThreadId }).filter((row) => row.kind === "thread" || row.kind === "incident" || row.kind === "patch");
    for (const row of [...links].reverse()) {
      if (origin.length >= INFO_THREADS) break;
      const header = store.getMessage(row.messageId);
      if (header === null) continue;
      const key = `${header.accountId}\u0000${header.threadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const thread = store.getThread(header.threadId, header.folder)?.thread;
      if (thread !== undefined) origin.push(thread);
    }
    const total = store.projectThreads(input.projectId, { cursor: null, limit: INFO_TOTAL_MAX }).threads.length;
    return { bound, origin, total };
  }


  // ---- Mail rules (Task 12) ----

  let lastPaused: string[] | null = null;

  function ruleView(rule: RuleRecord, list: ProjectInfo[] | null) {
    return {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      match: rule.match,
      projectId: rule.projectId,
      projectName: list?.find((project) => project.id === rule.projectId)?.name ?? null,
      template: rule.template,
      mode: rule.mode,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }

  async function rulesList() {
    const list = await listOrNull();
    return { rules: store.listRules().map((rule) => ruleView(rule, list)) };
  }

  async function ruleSave(input: {
    id?: string | undefined;
    name: string;
    enabled: boolean;
    match: RuleMatch;
    projectId: string;
    template: string;
    mode: "prepare" | "start";
    confirmedStart?: boolean | undefined;
  }) {
    const match = normalizeRuleMatch(input.match);
    const name = input.name.trim();
    const checked = validateRule({
      name,
      match,
      template: input.template,
      mode: input.mode,
      projectId: input.projectId,
      ...(input.confirmedStart === undefined ? {} : { confirmedStart: input.confirmedStart }),
    });
    if (!checked.ok) throw refuse("invalid", checked.reason);
    if (input.id !== undefined && !store.listRules().some((rule) => rule.id === input.id)) throw refuse("not_found", UNKNOWN_RULE_TEXT);
    const project = await projectOf(input.projectId, "rule_save");
    // Start runs only in a managed worktree of the project's checkout (resolution 1).
    if (input.mode === "start" && project.tree === null) throw refuse("conflict", BB_REFUSAL_TEXT.no_tree);
    const saved = store.saveRule(
      {
        id: input.id ?? `rule_${deps.newId()}`,
        name,
        enabled: input.enabled,
        match,
        projectId: input.projectId,
        template: input.template,
        mode: input.mode,
      },
      nowIso(),
    );
    if ("full" in saved) throw refuse("conflict", RULES_FULL_TEXT);
    return ruleView(saved.rule, await listOrNull());
  }

  function ruleDelete(input: { id: string }) {
    // Its runs stay until the 30-day purge, so the caps still count them.
    if (!store.deleteRule(input.id)) throw refuse("not_found", UNKNOWN_RULE_TEXT);
    return { ok: true as const };
  }

  /** Pause all: disables every rule and remembers them; `undo` enables that set again. */
  function rulesPause(input: { undo?: boolean | undefined }) {
    if (input.undo === true) {
      const ids = lastPaused ?? [];
      lastPaused = null;
      store.resumeRules(ids, nowIso());
      return { paused: 0 };
    }
    const ids = store.pauseRules(nowIso());
    lastPaused = ids;
    return { paused: ids.length };
  }

  function ruleRunView(run: RuleRunRecord, names: ReadonlyMap<string, string>) {
    return {
      id: run.id,
      ruleId: run.ruleId,
      ruleName: names.get(run.ruleId) ?? null,
      accountId: run.accountId,
      messageId: run.messageId,
      threadId: run.threadId,
      state: run.state,
      bbThreadId: run.bbThreadId,
      subject: store.getMessage(run.messageId)?.subject ?? "",
      createdAt: run.createdAt,
    };
  }

  function ruleRunsList(input: { state?: RuleRunState | undefined; cursor?: string | null | undefined }) {
    const page = store.listRuleRuns({ ...(input.state === undefined ? {} : { state: input.state }), cursor: input.cursor ?? null, limit: RULE_RUNS_PAGE });
    const names = new Map(store.listRules().map((rule) => [rule.id, rule.name]));
    return { runs: page.runs.map((run) => ruleRunView(run, names)), next: page.next };
  }

  function ruleRunDismiss(input: { id: string }) {
    const run = store.getRuleRun(input.id);
    if (run === null || (run.state !== "ready" && run.state !== "failed" && run.state !== "capped")) throw refuse("not_found", UNKNOWN_RULE_RUN_TEXT);
    store.updateRuleRun(run.id, { state: "dismissed" }, nowIso());
    return { ok: true as const };
  }

  /** Today's "ready to start" count. */
  function rulesReady(): number {
    return store.listRuleRuns({ state: "ready", limit: 500 }).runs.length;
  }

  return {
    rulesList,
    ruleSave,
    ruleDelete,
    rulesPause,
    ruleRunsList,
    ruleRunDismiss,
    rulesReady,
    devDigest,
    todayDev,
    threadDetail,
    patchView,
    patchSave,
    patchHandoff,
    alertView,
    incidentStart,
    incidentAppend,
    conversationProjectSet,
    bindingAdd,
    bindingRemove,
    bindingsList,
    projectMail,
    bbThreadMail,
    projectsList,
    threadPrepare,
    threadStart,
    threadsRecent,
    taskTargets,
    taskFromMail,
    attachmentSave,
    projectFiles,
    projectFolders,
    threadFiles,
    composeAttachBb,
    draftFromBb,
    withBbLinks,
  };
}

export type BbRpc = ReturnType<typeof createBbRpc>;
