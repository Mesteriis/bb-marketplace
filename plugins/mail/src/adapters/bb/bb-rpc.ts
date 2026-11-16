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
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import {
  BB_REFUSAL_TEXT,
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
  type BbLinkRow,
  type BbMessage,
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
import { projectDefaultEnvironment } from "./bb-threads.ts";
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

export type BbSettings = {
  attachmentFolder: string;
  patchFolder: string;
  taskTarget: "auto" | "taskboard" | "local";
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

  return {
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
