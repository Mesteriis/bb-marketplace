// Compose use cases: start a new draft, prepare a reply or forward, open (or
// continue) a draft, autosave it, copy it to the account's Drafts folder, and
// discard it. The local row is always written before any server step; every
// server write of an account runs through its write queue. The only server
// removal is expungeOwn of a draft copy this plugin wrote (or the one foreign
// draft the owner continued), on servers with UIDPLUS.
import { parseAddress, type OutgoingAddress } from "./compose-address.ts";
import { insertBccHeader, bccHeaderLine } from "./compose-bcc.ts";
import {
  docFromLines,
  docLosesContent,
  htmlFitsDoc,
  normalizeDoc,
  renderDoc,
  type DocNodeInput,
  type ComposeDoc,
} from "./compose-doc.ts";
import { serverCopyDue, type ServerCopyReason } from "./compose-drafts.ts";
import {
  quoteHeaderText,
  replyRecipients,
  threadingHeaders,
  type ReplySource,
} from "./compose-reply.ts";
import { forwardSubject, replySubject } from "./compose-subjects.ts";
import { normalizeMessageId } from "./headers.ts";
import type {
  DraftRecord,
  DraftServerCopy,
  DraftServerCopyState,
  DraftView,
  MailAddress,
  OutgoingAttachment,
  OutgoingMessage,
  SpecialUse,
  StoredAccount,
} from "./model.ts";
import type {
  AccountWriteQueue,
  Clock,
  FolderSession,
  ImapConfig,
  ImapGateway,
  MailStore,
  MessageBuilder,
  OriginalReader,
  SecretVault,
} from "./ports.ts";

/** Per file, and for all attachments of one message. */
export const ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;
/** Recipients of one message, To, Cc and Bcc together. */
export const MAX_RECIPIENTS = 100;

export type ComposeDeps = {
  store: MailStore;
  gateway: ImapGateway;
  vault: SecretVault;
  clock: Clock;
  newId: () => string;
  builder: MessageBuilder;
  reader: OriginalReader;
  queue: AccountWriteQueue;
};

export type ComposeErrorKind =
  | "not_found"
  | "conflict"
  | "invalid"
  | "queued"
  | "too_large"
  | "smtp_missing"
  | "rate_limited"
  | "undone";

const COMPOSE_ERROR_TEXT: Record<ComposeErrorKind, string> = {
  not_found: "Not found",
  conflict: "This draft changed in another window",
  invalid: "The message is not ready to send",
  queued: "A send of this draft is queued",
  too_large: "Attachments are over the size limit",
  smtp_missing: "SMTP is not set for this account",
  rate_limited: "Too many messages sent in the last minute",
  undone: "This send was undone",
};

/** A refusal with fixed text: never an address, subject, file name or server reply. */
export class ComposeError extends Error {
  readonly kind: ComposeErrorKind;
  constructor(kind: ComposeErrorKind) {
    super(COMPOSE_ERROR_TEXT[kind]);
    this.name = "ComposeError";
    this.kind = kind;
  }
}

/**
 * original_kept: a continued foreign draft could not be read in full (the
 * server did not answer, attachments over the cap, or HTML the editor
 * cannot hold), so it stays on the server and this draft is saved beside it.
 */
export type ComposeWarning = "original_unavailable" | "attachments_left_out" | "original_kept" | null;

const EMPTY_DOC: ComposeDoc = { type: "doc", content: [{ type: "paragraph" }] };
const DRAFT_FLAGS = ["\\Draft", "\\Seen"];

// ---------------------------------------------------------------------------
// New, prepare, open
// ---------------------------------------------------------------------------

/** An empty draft from the account. */
export function newCompose(deps: ComposeDeps, accountId: string): { draftId: string } {
  const account = requireAccount(deps.store, accountId);
  const draft = deps.store.createDraft({
    id: deps.newId(),
    kind: "new",
    accountId: account.id,
    sourceMessageId: null,
    messageId: newMessageIdFor(deps, account),
    inReplyTo: null,
    references: [],
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    doc: EMPTY_DOC,
    serverCopy: null,
    importHtml: null,
    origin: "owner",
    proposalId: null,
    createdAt: deps.clock.now().toISOString(),
  });
  return { draftId: draft.id };
}

/**
 * A reply, reply-all or forward draft of a stored message: recipients,
 * subject and threading from the store (Reply-To from the server when the
 * row predates its column), the quote header lines, the original's HTML to
 * quote (or its stored text as a quote), and for a forward the original's
 * attachments within the cap. When the server cannot be read the stored
 * fields are used with `original_unavailable`.
 */
export async function prepareCompose(
  deps: ComposeDeps,
  input: { kind: "reply" | "reply_all" | "forward"; messageId: string },
): Promise<{ draftId: string; warning: ComposeWarning; dropped: string[] }> {
  const source = deps.store.replySource(input.messageId);
  if (source === null) throw new ComposeError("not_found");
  const account = requireAccount(deps.store, source.accountId);

  let warning: ComposeWarning = null;
  let original: Awaited<ReturnType<OriginalReader["read"]>> | null = null;
  if (input.kind === "forward" || !source.replyToKnown) {
    try {
      original = await deps.reader.read(input.messageId);
    } catch {
      warning = "original_unavailable";
    }
  }
  const replySource: ReplySource = {
    ...source,
    replyTo: source.replyToKnown ? source.replyTo : (original?.replyTo ?? []),
  };

  let to: MailAddress[] = [];
  let cc: MailAddress[] = [];
  let dropped: string[] = [];
  let subject: string;
  let threading: { inReplyTo: string | null; references: string[] } = { inReplyTo: null, references: [] };
  if (input.kind === "forward") {
    subject = forwardSubject(source.subject);
  } else {
    const recipients = replyRecipients(replySource, input.kind, ownAddresses(deps.store));
    to = recipients.to;
    cc = recipients.cc;
    dropped = recipients.dropped;
    subject = replySubject(source.subject);
    threading = threadingHeaders(replySource);
  }

  const header = quoteHeaderText(replySource, input.kind);
  const html = original?.html ?? deps.store.getBody(input.messageId)?.html ?? null;
  let doc: ComposeDoc;
  if (html !== null) {
    doc = docFromLines(["", ...header]);
  } else {
    const text = deps.store.getBody(input.messageId)?.text ?? "";
    doc = docFromLines(["", ...header], text === "" ? undefined : splitLines(text));
  }

  const draft = deps.store.createDraft({
    id: deps.newId(),
    kind: input.kind,
    accountId: account.id,
    sourceMessageId: input.messageId,
    messageId: newMessageIdFor(deps, account),
    inReplyTo: threading.inReplyTo,
    references: threading.references,
    to,
    cc,
    bcc: [],
    subject,
    doc,
    serverCopy: null,
    importHtml: html === null ? null : { html, into: "quote" },
    origin: "owner",
    proposalId: null,
    createdAt: deps.clock.now().toISOString(),
  });

  if (input.kind === "forward" && original !== null) {
    const leftOut = await addWithinCap(deps.store, draft.id, original.attachments);
    if (leftOut && warning === null) warning = "attachments_left_out";
  }
  return { draftId: draft.id, warning, dropped };
}

/**
 * One of our drafts by id, or a synced Drafts message by its message id: the
 * row whose server copy it is or that already continues it, else a new row
 * continuing it (recipients with Bcc, body, attachments and threading). Only
 * an original read in full (the server answered, every attachment within the
 * cap, HTML the editor holds without loss) with a Message-ID and UIDVALIDITY
 * to guard it has its uid recorded and keeps its Message-ID, so our first copy replaces it; any
 * other stays on the server untouched (`original_kept`) and the draft gets
 * its own Message-ID.
 */
export async function openDraft(
  deps: ComposeDeps,
  input: { draftId: string } | { draftMessageId: string },
): Promise<{ draft: DraftView; warning: ComposeWarning }> {
  if ("draftId" in input) {
    const draft = deps.store.getDraft(input.draftId);
    if (draft === null) throw new ComposeError("not_found");
    return { draft: draftView(deps.store, draft), warning: null };
  }

  const ref = deps.store.rawRef(input.draftMessageId);
  if (ref === null) throw new ComposeError("not_found");
  const existing =
    deps.store.draftForServerCopy(ref.accountId, ref.folder, ref.uid) ?? deps.store.draftContinuing(input.draftMessageId);
  if (existing !== null) {
    const draft = deps.store.getDraft(existing);
    if (draft !== null) return { draft: draftView(deps.store, draft), warning: null };
  }
  const folder = deps.store.listFolders(ref.accountId).find((f) => f.path === ref.folder);
  if (folder?.specialUse !== "drafts") throw new ComposeError("invalid");
  const account = requireAccount(deps.store, ref.accountId);
  const source = deps.store.replySource(input.draftMessageId);
  if (source === null) throw new ComposeError("not_found");

  let original: Awaited<ReturnType<OriginalReader["read"]>> | null = null;
  try {
    original = await deps.reader.read(input.draftMessageId);
  } catch {
    original = null;
  }
  const html = original?.html ?? null;
  const text = deps.store.getBody(input.draftMessageId)?.text ?? "";
  const ownId = ref.messageId === null ? "" : normalizeMessageId(ref.messageId);
  const attachmentBytes = (original?.attachments ?? []).reduce((sum, a) => sum + a.bytes.length, 0);
  const readInFull =
    original !== null && attachmentBytes <= ATTACHMENT_CAP_BYTES && (html === null || htmlFitsDoc(html));
  // Without its Message-ID (or a synced UIDVALIDITY) the foreign copy cannot
  // be guarded, and without the whole of it our copy would lose content: in
  // both cases it is never removed, and our copy is added beside it.
  const serverCopy: DraftServerCopy | null =
    readInFull && ownId !== "" && ref.uidValidity !== null
      ? { folder: ref.folder, uidValidity: ref.uidValidity, uid: ref.uid, revision: 1, size: ref.size }
      : null;

  const draft = deps.store.createDraft({
    id: deps.newId(),
    kind: "new",
    accountId: account.id,
    sourceMessageId: input.draftMessageId,
    // Only the draft that replaces the original carries its Message-ID; one
    // saved beside it gets its own, so Drafts never holds two sharing one.
    messageId: serverCopy !== null ? `<${ownId}>` : newMessageIdFor(deps, account),
    inReplyTo: source.inReplyTo,
    references: source.references,
    to: source.to.map(chip),
    cc: source.cc.map(chip),
    bcc: (original?.bcc ?? []).map(chip),
    subject: source.subject,
    doc: html !== null || text === "" ? EMPTY_DOC : docFromLines(splitLines(text)),
    serverCopy,
    importHtml: html === null ? null : { html, into: "body" },
    origin: "owner",
    proposalId: null,
    createdAt: deps.clock.now().toISOString(),
  });
  if (original !== null) await addWithinCap(deps.store, draft.id, original.attachments);
  const warning: ComposeWarning = serverCopy === null ? "original_kept" : null;
  return { draft: draftView(deps.store, deps.store.getDraft(draft.id)!), warning };
}

// ---------------------------------------------------------------------------
// Save, server copy, discard
// ---------------------------------------------------------------------------

export type SaveComposeInput = {
  draftId: string;
  baseRevision: number;
  accountId: string;
  /** As typed: "a@example.com" or "Name <a@example.com>". Invalid chips are kept as typed. */
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  doc: DocNodeInput;
  saveToServer?: boolean;
  /** The editor's one-time load of the draft's import: not an edit. */
  imported?: boolean;
};

export type SaveComposeResult =
  | { revision: number; originalKept?: true }
  | { conflict: true; revision: number };

/**
 * Autosave: the local row first (compare-and-swap on the revision; conflict
 * while a send of it is queued), then, on Save draft, the server copy. A
 * change of account removes the copy from the old account's Drafts.
 *
 * `imported`: the editor loaded the draft's import. Only the document is
 * stored, the revision stays (so no server copy becomes due), and when the
 * load lost content a continued foreign draft is let go: it stays on the
 * server and is never expunged (`originalKept`), and the draft takes its own
 * Message-ID.
 */
export async function saveCompose(deps: ComposeDeps, input: SaveComposeInput): Promise<SaveComposeResult> {
  const before = deps.store.getDraft(input.draftId);
  if (before === null) throw new ComposeError("not_found");
  requireAccount(deps.store, input.accountId);
  if (input.imported === true) {
    const result = deps.store.saveImport(input.draftId, input.baseRevision, normalizeDoc(input.doc));
    if ("conflict" in result) return result;
    if (before.serverCopy !== null && docLosesContent(input.doc)) {
      deps.store.recordServerCopy(input.draftId, null);
      // Still pointing at the foreign original it continues: the draft now
      // lives beside it, so it stops sharing its Message-ID.
      const original = before.sourceMessageId === null ? null : deps.store.rawRef(before.sourceMessageId);
      if (original !== null && original.folder === before.serverCopy.folder && original.uid === before.serverCopy.uid) {
        deps.store.renewMessageId(input.draftId, newMessageIdFor(deps, requireAccount(deps.store, before.accountId)));
      }
      return { revision: result.revision, originalKept: true };
    }
    return result;
  }
  const result = deps.store.saveDraft(
    input.draftId,
    input.baseRevision,
    {
      accountId: input.accountId,
      to: input.to.map(chipOf),
      cc: input.cc.map(chipOf),
      bcc: input.bcc.map(chipOf),
      subject: input.subject.replace(/[\r\n\u0000]+/g, " "),
      doc: normalizeDoc(input.doc),
    },
    deps.clock.now().toISOString(),
  );
  if ("conflict" in result) return result;

  if (before.accountId !== input.accountId && before.serverCopy !== null) {
    await removeServerCopy(deps, before.accountId, before.serverCopy, before.messageId);
    if (deps.store.getDraft(input.draftId) !== null) deps.store.recordServerCopy(input.draftId, null);
  }
  if (input.saveToServer === true) await writeServerCopy(deps, input.draftId, "save");
  return result;
}

export type ServerCopyOutcome = DraftServerCopyState | "skipped";

/**
 * Copies the draft (Bcc kept, flags \Draft \Seen) to the account's Drafts
 * folder when due, records the new APPENDUID, then removes the previous
 * copy by UID (UIDPLUS, same UIDVALIDITY, Message-ID and size guard) and
 * its local row. A failed APPEND keeps everything and deletes nothing; a
 * vanished previous copy only means nothing is removed. Never throws.
 */
export async function writeServerCopy(
  deps: ComposeDeps,
  draftId: string,
  reason: ServerCopyReason,
): Promise<ServerCopyOutcome> {
  const first = deps.store.getDraft(draftId);
  if (first === null) return "skipped";
  if (reason === "tick" && first.serverState === "local_only") return "skipped";
  const drafts = roleFolder(deps.store, first.accountId, "drafts");
  if (drafts === null) {
    deps.store.setServerCopyState(draftId, "local_only");
    return "local_only";
  }
  const due = (draft: DraftRecord, uidplus: boolean) =>
    serverCopyDue({
      revision: draft.revision,
      serverRevision: draft.serverCopy?.revision ?? null,
      updatedAt: draft.updatedAt,
      now: deps.clock.now().toISOString(),
      hasAttachments: deps.store.listAttachments(draft.id).length > 0,
      uidplus,
      hasDraftsFolder: true,
      reason,
    });
  if (!due(first, true)) return "skipped";

  try {
    return await deps.queue.run(first.accountId, async () => {
      const draft = deps.store.getDraft(draftId);
      if (draft === null || draft.accountId !== first.accountId) return "skipped";
      if (isQueued(deps.store, draft)) return "skipped";
      const account = requireAccount(deps.store, draft.accountId);
      const session = await deps.gateway.openFolder(imapConfigOf(account, deps.vault), drafts, {
        readOnly: false,
      });
      try {
        if (!session.capabilities().uidplus) {
          deps.store.setServerCopyState(draftId, "local_only");
          return "local_only";
        }
        if (!due(draft, true)) return "skipped";
        const raw = await draftBytes(deps, account, draft);
        const status = await session.status();
        let appended: { uidValidity: number | null; uid: number | null };
        try {
          appended = await session.appendMessage(raw, DRAFT_FLAGS);
        } catch {
          deps.store.setServerCopyState(draftId, "failed");
          return "failed";
        }
        const uidValidity = appended.uidValidity ?? status.uidValidity;
        if (appended.uid === null) {
          // No APPENDUID: this copy can never be superseded, so stop adding more.
          deps.store.setServerCopyState(draftId, "local_only");
          return "local_only";
        }
        const now = deps.store.getDraft(draftId);
        if (now === null) {
          // Discarded or sent while the APPEND ran: the copy just written is ours to remove.
          await expungeQuietly(session, appended.uid, draft.messageId, raw.length);
          return "skipped";
        }
        deps.store.recordServerCopy(draftId, {
          folder: drafts,
          uidValidity,
          uid: appended.uid,
          revision: draft.revision,
          size: raw.length,
        });
        const previous = draft.serverCopy;
        if (
          previous !== null &&
          previous.folder === drafts &&
          previous.uidValidity === uidValidity &&
          previous.uid !== appended.uid
        ) {
          if (await expungeQuietly(session, previous.uid, draft.messageId, previous.size)) {
            deps.store.deleteByUids(account.id, drafts, [previous.uid]);
          }
        }
        return "saved";
      } finally {
        await session.close().catch(() => undefined);
      }
    });
  } catch {
    if (deps.store.getDraft(draftId) !== null) deps.store.setServerCopyState(draftId, "failed");
    return "failed";
  }
}

/** Deletes the draft (refused while a send of it is queued) and the server copy it owns. */
export async function discardCompose(deps: ComposeDeps, draftId: string): Promise<{ ok: true }> {
  const draft = deps.store.getDraft(draftId);
  if (draft === null) return { ok: true };
  if (isQueued(deps.store, draft)) throw new ComposeError("queued");
  if (draft.serverCopy !== null) {
    await removeServerCopy(deps, draft.accountId, draft.serverCopy, draft.messageId);
  }
  deps.store.deleteDraft(draftId);
  return { ok: true };
}

/**
 * Removes one server copy the draft owns: UIDPLUS, unchanged UIDVALIDITY,
 * the Message-ID and size guard, UID EXPUNGE of that uid alone; then drops
 * its local row. False (and nothing removed) on any doubt. Never throws.
 */
export async function removeServerCopy(
  deps: Pick<ComposeDeps, "store" | "gateway" | "vault" | "queue">,
  accountId: string,
  copy: DraftServerCopy,
  messageId: string,
): Promise<boolean> {
  try {
    return await deps.queue.run(accountId, async () => {
      const account = deps.store.getAccount(accountId);
      if (account === null) return false;
      const session = await deps.gateway.openFolder(imapConfigOf(account, deps.vault), copy.folder, {
        readOnly: false,
      });
      try {
        if (!session.capabilities().uidplus) return false;
        const status = await session.status();
        if (status.uidValidity !== copy.uidValidity) return false;
        if (!(await expungeQuietly(session, copy.uid, messageId, copy.size))) return false;
        deps.store.deleteByUids(accountId, copy.folder, [copy.uid]);
        return true;
      } finally {
        await session.close().catch(() => undefined);
      }
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** Bytes still free under the per-message cap. */
export function attachmentRoom(store: MailStore, draftId: string): number {
  const used = store.listAttachments(draftId).reduce((sum, a) => sum + a.size, 0);
  return Math.max(0, ATTACHMENT_CAP_BYTES - used);
}

/** Stores a finished upload: refused while queued, and over the per-file or per-message cap. */
export function addComposeAttachment(
  store: MailStore,
  draftId: string,
  file: { fileName: string; mimeType: string; size: number; sha256: string; data: Uint8Array },
) {
  const draft = store.getDraft(draftId);
  if (draft === null) throw new ComposeError("not_found");
  if (isQueued(store, draft)) throw new ComposeError("queued");
  if (file.size !== file.data.length) throw new ComposeError("invalid");
  if (file.size > ATTACHMENT_CAP_BYTES || file.size > attachmentRoom(store, draftId)) {
    throw new ComposeError("too_large");
  }
  return store.addAttachment(draftId, file);
}

export function removeComposeAttachment(store: MailStore, draftId: string, attachmentId: string): boolean {
  const draft = store.getDraft(draftId);
  if (draft === null) return false;
  if (isQueued(store, draft)) throw new ComposeError("queued");
  return store.removeAttachment(draftId, attachmentId);
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by compose-outbox.ts)
// ---------------------------------------------------------------------------

export function requireAccount(store: MailStore, accountId: string): StoredAccount {
  const account = store.getAccount(accountId);
  if (account === null) throw new ComposeError("not_found");
  return account;
}

export function imapConfigOf(account: StoredAccount, vault: SecretVault): ImapConfig {
  return {
    host: account.host,
    port: account.port,
    user: account.username,
    password: vault.open(account.passwordSealed),
  };
}

/** The account's selectable folder with that special use, or null. */
export function roleFolder(store: MailStore, accountId: string, role: SpecialUse): string | null {
  return store.listFolders(accountId).find((f) => f.specialUse === role && f.selectable)?.path ?? null;
}

/** A live outbox row holds the draft (done rows are deleted, so every row is live). */
export function isQueued(store: MailStore, draft: DraftRecord): boolean {
  return store.listOutbox(draft.accountId).some((row) => row.draftId === draft.id);
}

export function draftView(store: MailStore, draft: DraftRecord): DraftView {
  return {
    id: draft.id,
    accountId: draft.accountId,
    kind: draft.kind,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    doc: draft.doc,
    attachments: store.listAttachments(draft.id),
    revision: draft.revision,
    serverCopy: draft.serverState,
    queued: isQueued(store, draft),
    continues: draft.kind === "new" && draft.sourceMessageId !== null,
    import: draft.importHtml,
    origin: draft.origin,
  };
}

/** Every connected account's address: never a reply-all recipient. */
export function ownAddresses(store: MailStore): string[] {
  return store.listAccounts().flatMap((a) => (a.username.includes("@") ? [a.email, a.username] : [a.email]));
}

/**
 * The message the builder gets for a draft. `strict` (a send): every chip
 * must be a valid address, else `invalid`. Otherwise (a Drafts copy)
 * invalid chips are left out of the copy; the local row keeps them.
 */
export function outgoingOf(
  deps: Pick<ComposeDeps, "store" | "clock">,
  account: StoredAccount,
  draft: DraftRecord,
  strict: boolean,
): OutgoingMessage {
  const from = parseAddress(account.email);
  if (!from.ok) throw new ComposeError("invalid");
  const list = (entries: MailAddress[]): OutgoingAddress[] =>
    entries.flatMap((entry) => {
      const parsed = parseAddress(entry.address);
      if (!parsed.ok) {
        if (strict) throw new ComposeError("invalid");
        return [];
      }
      const name = entry.name?.trim() ?? "";
      return [{ name: name === "" ? null : name, address: parsed.value.address }];
    });
  const attachments: OutgoingAttachment[] = deps.store.attachmentData(draft.id).map((a) => ({
    fileName: a.fileName,
    mimeType: a.mimeType,
    bytes: a.data,
    contentId: a.contentId,
  }));
  const { html, text } = renderDoc(draft.doc);
  return {
    from: { name: account.displayName?.trim() || null, address: from.value.address },
    to: list(draft.to),
    cc: list(draft.cc),
    bcc: list(draft.bcc),
    subject: draft.subject,
    messageId: draft.messageId,
    date: deps.clock.now().toISOString(),
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    html,
    text,
    attachments,
  };
}

/** SHA-256 hex through the global Web Crypto (no import, so the core stays host-free). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function draftBytes(deps: ComposeDeps, account: StoredAccount, draft: DraftRecord): Promise<Uint8Array> {
  const message = outgoingOf(deps, account, draft, false);
  const raw = await deps.builder.build(message);
  const bcc = bccHeaderLine(message.bcc);
  return bcc === null ? raw : insertBccHeader(raw, bcc);
}

async function expungeQuietly(
  session: FolderSession,
  uid: number,
  messageId: string,
  size: number,
): Promise<boolean> {
  try {
    await session.expungeOwn(uid, { messageId, size });
    return true;
  } catch {
    return false;
  }
}

/** Copies attachments in order while they fit; true when any was left out. */
async function addWithinCap(store: MailStore, draftId: string, files: OutgoingAttachment[]): Promise<boolean> {
  let leftOut = false;
  for (const file of files) {
    const size = file.bytes.length;
    if (size > attachmentRoom(store, draftId)) {
      leftOut = true;
      continue;
    }
    store.addAttachment(draftId, {
      fileName: file.fileName,
      mimeType: file.mimeType,
      size,
      sha256: await sha256Hex(file.bytes),
      data: file.bytes,
      contentId: file.contentId,
    });
  }
  return leftOut;
}

/** `<random@account-domain>`. */
function newMessageIdFor(deps: Pick<ComposeDeps, "newId">, account: StoredAccount): string {
  const parsed = parseAddress(account.email);
  const domain = parsed.ok ? parsed.value.address.slice(parsed.value.address.lastIndexOf("@") + 1) : "localhost";
  const local = deps.newId().replace(/[^A-Za-z0-9.-]/g, "");
  return `<${local === "" ? "draft" : local}@${domain}>`;
}

/** A typed chip: parsed when it is an address, else kept as typed so the composer can flag it. */
function chipOf(typed: string): MailAddress {
  const parsed = parseAddress(typed);
  if (parsed.ok) return { name: parsed.value.name, address: parsed.value.address };
  return { name: null, address: typed.trim() };
}

function chip(address: MailAddress): MailAddress {
  return { name: address.name, address: address.address };
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

