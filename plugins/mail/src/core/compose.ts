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
import { stripOwnSignature, withSignature } from "./compose-signature.ts";
import { identitiesOf, identityOf, ownIdentityAddresses, replyIdentity, type Identity } from "./identities.ts";
import {
  quoteHeaderText,
  replyRecipients,
  threadingHeaders,
  type ReplySource,
} from "./compose-reply.ts";
import { forwardSubject, replySubject } from "./compose-subjects.ts";
import { normalizeMessageId } from "./headers.ts";
import type {
  DraftOrigin,
  DraftPurpose,
  DraftRecord,
  DraftServerCopy,
  DraftServerCopyState,
  DraftView,
  MailAddress,
  NewDraft,
  OriginalMessage,
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
  | "undone"
  | "from_unknown";

const COMPOSE_ERROR_TEXT: Record<ComposeErrorKind, string> = {
  not_found: "Not found",
  conflict: "This draft changed in another window",
  invalid: "The message is not ready to send",
  queued: "A send of this draft is queued",
  too_large: "Attachments are over the size limit",
  smtp_missing: "SMTP is not set for this account",
  rate_limited: "Too many messages sent in the last minute",
  undone: "This send was undone",
  from_unknown: "This sending address is no longer set up for the account; choose another From",
};

/**
 * A refusal with fixed text: never an address, subject, file name or server
 * reply. `text` replaces the kind's text with another fixed string (a
 * literal in the code, never data).
 */
export class ComposeError extends Error {
  readonly kind: ComposeErrorKind;
  constructor(kind: ComposeErrorKind, text?: string) {
    super(text ?? COMPOSE_ERROR_TEXT[kind]);
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

/**
 * A draft about to be written: the NewDraft fields without the row id, the
 * origin, the proposal id and the time, plus the attachments to copy (a
 * forward's, within the cap), the warning and the dropped own addresses.
 * `original`: for a reply or forward, the source as the Reply rules saw it
 * and its stored text and HTML, so an agent proposal can build its own
 * plain-text quote (slice 3c); null for a new message.
 */
export type ComposePlan = Omit<NewDraft, "id" | "origin" | "proposalId" | "createdAt"> & {
  attachments: OriginalMessage["attachments"];
  warning: ComposeWarning;
  dropped: string[];
  original: { source: ReplySource; text: string | null; html: string | null } | null;
};

/**
 * An empty draft from the account, not yet written, from `fromAddress` (one
 * of the account's identities; null or absent = its own address): the
 * identity's signature block at the end and a Message-ID at its domain.
 * An address that is not an active identity of the account is `invalid`.
 */
export function planNew(
  deps: Pick<ComposeDeps, "store" | "newId">,
  accountId: string,
  fromAddress: string | null = null,
): ComposePlan {
  const account = requireAccount(deps.store, accountId);
  const identity = identityOf(accountIdentities(deps.store, account), fromAddress);
  if (identity === null) throw new ComposeError("invalid");
  return {
    kind: "new",
    accountId: account.id,
    sourceMessageId: null,
    messageId: newMessageIdFor(deps, identity.primary ? account.email : identity.address),
    inReplyTo: null,
    references: [],
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    doc: withSignature(EMPTY_DOC, identity.signature, "new"),
    fromAddress: fromAddressOf(identity),
    serverCopy: null,
    importHtml: null,
    attachments: [],
    warning: null,
    dropped: [],
    original: null,
  };
}

/**
 * The unsubscribe email for a stored list message (slice 3e), not yet
 * written: From the identity the list mail came to (the reply-from rule),
 * To the list's mailto address, its subject and body as plain text, no
 * signature, no quote, no threading, no attachments. Writes nothing.
 */
export function planUnsubscribe(
  deps: Pick<ComposeDeps, "store" | "newId">,
  messageId: string,
  mailto: { address: string; subject: string; body: string },
): ComposePlan {
  const source = deps.store.replySource(messageId);
  if (source === null) throw new ComposeError("not_found");
  const account = requireAccount(deps.store, source.accountId);
  const identity = replyIdentity(
    { ...source, replyTo: source.replyToKnown ? source.replyTo : [], deliveredTo: deps.store.deliveredToOf(messageId) },
    accountIdentities(deps.store, account),
  );
  const plan = planNew(deps, account.id, fromAddressOf(identity));
  return {
    ...plan,
    to: [{ name: null, address: mailto.address }],
    subject: mailto.subject,
    doc: docFromLines(mailto.body === "" ? [] : splitLines(mailto.body)),
  };
}

/** The MIME type an invitation answer is kept under on its hidden draft. */
export const INVITE_REPLY_MIME = "text/calendar; method=REPLY; charset=utf-8";

/**
 * The answer to a calendar invitation (slice 3l), not yet written: from the
 * invited address (one of the account's identities), to the organizer, one
 * line of text, and the calendar text as the draft's one attachment
 * (outgoingOf sends it as the body's text/calendar alternative).
 */
export function planInviteReply(
  deps: Pick<ComposeDeps, "store" | "newId">,
  messageId: string,
  reply: { from: string; to: MailAddress; subject: string; body: string; calendar: string },
): ComposePlan {
  const source = deps.store.replySource(messageId);
  if (source === null) throw new ComposeError("not_found");
  const account = requireAccount(deps.store, source.accountId);
  const wanted = reply.from.trim().toLowerCase();
  const identity = accountIdentities(deps.store, account).find((entry) => entry.address.toLowerCase() === wanted);
  if (identity === undefined) throw new ComposeError("from_unknown");
  const plan = planNew(deps, account.id, fromAddressOf(identity));
  return {
    ...plan,
    to: [reply.to],
    subject: reply.subject,
    doc: docFromLines([reply.body]),
    attachments: [
      { fileName: "invite.ics", mimeType: INVITE_REPLY_MIME, bytes: new TextEncoder().encode(reply.calendar), contentId: null },
    ],
  };
}

/**
 * A reply, reply-all or forward of a stored message, not yet written:
 * recipients, subject and threading from the store (Reply-To from the server
 * when the row predates its column), the quote header lines, the original's
 * HTML to quote (or its stored text as a quote), and for a forward the
 * original's attachments. When the server cannot be read the stored fields
 * are used with `original_unavailable`. Writes nothing.
 */
export async function planCompose(
  deps: Pick<ComposeDeps, "store" | "newId" | "reader">,
  input: { kind: "reply" | "reply_all" | "forward"; messageId: string },
): Promise<ComposePlan> {
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

  // From: the identity the original came to (only this account's), and its signature.
  const identity = replyIdentity(
    { ...replySource, deliveredTo: deps.store.deliveredToOf(input.messageId) },
    accountIdentities(deps.store, account),
  );
  // Replies to the owner's own mail leave its signature out of the quote; a forward keeps it.
  const stripSignature = input.kind !== "forward" && isOwnAddress(deps.store, source.from.address);
  const header = quoteHeaderText(replySource, input.kind);
  const body = deps.store.getBody(input.messageId);
  const html = original?.html ?? body?.html ?? null;
  const text = body?.text ?? null;
  let doc: ComposeDoc;
  if (html !== null) {
    doc = docFromLines(["", ...header]);
  } else {
    const lines = text === null || text === "" ? undefined : splitLines(text);
    doc = docFromLines(["", ...header], lines === undefined || !stripSignature ? lines : stripOwnSignature(lines));
  }
  doc = withSignature(doc, identity.signature, input.kind);

  return {
    kind: input.kind,
    accountId: account.id,
    sourceMessageId: input.messageId,
    messageId: newMessageIdFor(deps, identity.primary ? account.email : identity.address),
    inReplyTo: threading.inReplyTo,
    references: threading.references,
    to,
    cc,
    bcc: [],
    subject,
    doc,
    fromAddress: fromAddressOf(identity),
    serverCopy: null,
    importHtml: html === null ? null : { html, into: "quote", stripSignature },
    attachments: input.kind === "forward" && original !== null ? original.attachments : [],
    warning,
    dropped,
    original: { source: replySource, text, html },
  };
}

/**
 * A draft the owner never sees as a draft (spec resolution 19): an agent
 * proposal's (reached only through its card) or one the plugin made for a
 * purpose (an unsubscribe email). No compose RPC, Drafts list or server copy
 * reaches it. The proposal flow reads `proposalId` itself.
 */
export function isHiddenDraft(draft: Pick<DraftRecord, "proposalId" | "purpose">): boolean {
  return draft.proposalId !== null || draft.purpose !== null;
}

/**
 * Writes a plan: one createDraft with its origin and proposal id (so a
 * hidden proposal draft is never visible for a moment), then its
 * attachments in order while they fit the cap. `leftOut` counts those that
 * did not; any sets `attachments_left_out` unless a warning is already set.
 */
export async function createComposeDraft(
  deps: Pick<ComposeDeps, "store" | "newId" | "clock">,
  plan: ComposePlan,
  options: { origin: DraftOrigin; proposalId: string | null; purpose?: DraftPurpose | null },
): Promise<{ draftId: string; warning: ComposeWarning; dropped: string[]; leftOut: number }> {
  const { attachments, warning, dropped, original: _original, ...fields } = plan;
  const draft = deps.store.createDraft({
    ...fields,
    id: deps.newId(),
    origin: options.origin,
    proposalId: options.proposalId,
    purpose: options.purpose ?? null,
    createdAt: deps.clock.now().toISOString(),
  });
  const leftOut = await addWithinCap(deps.store, draft.id, attachments);
  return {
    draftId: draft.id,
    warning: leftOut > 0 && warning === null ? "attachments_left_out" : warning,
    dropped,
    leftOut,
  };
}

/** An empty draft from the account (from `fromAddress`, one of its identities; null = its own address). */
export function newCompose(deps: ComposeDeps, accountId: string, fromAddress: string | null = null): { draftId: string } {
  const plan = planNew(deps, accountId, fromAddress);
  const { attachments: _a, warning: _w, dropped: _d, original: _o, ...fields } = plan;
  const draft = deps.store.createDraft({
    ...fields,
    id: deps.newId(),
    origin: "owner",
    proposalId: null,
    createdAt: deps.clock.now().toISOString(),
  });
  return { draftId: draft.id };
}

/**
 * A reply, reply-all or forward draft of a stored message: planCompose,
 * then createComposeDraft as an owner draft.
 */
export async function prepareCompose(
  deps: ComposeDeps,
  input: { kind: "reply" | "reply_all" | "forward"; messageId: string },
): Promise<{ draftId: string; warning: ComposeWarning; dropped: string[] }> {
  const plan = await planCompose(deps, input);
  const { draftId, warning, dropped } = await createComposeDraft(deps, plan, { origin: "owner", proposalId: null });
  return { draftId, warning, dropped };
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
    messageId: serverCopy !== null ? `<${ownId}>` : newMessageIdFor(deps, account.email),
    inReplyTo: source.inReplyTo,
    references: source.references,
    to: source.to.map(chip),
    cc: source.cc.map(chip),
    bcc: (original?.bcc ?? []).map(chip),
    subject: source.subject,
    doc: html !== null || text === "" ? EMPTY_DOC : docFromLines(splitLines(text)),
    // Its From, when that is one of the account's identities (own address or active alias).
    fromAddress: continuedFrom(deps.store, account, source.from.address),
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
  /** The identity to send from: null = the account's own address; absent = unchanged. */
  fromAddress?: string | null;
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
  const account = requireAccount(deps.store, input.accountId);
  if (input.imported === true) {
    const result = deps.store.saveImport(input.draftId, input.baseRevision, normalizeDoc(input.doc));
    if ("conflict" in result) return result;
    if (before.serverCopy !== null && docLosesContent(input.doc)) {
      deps.store.recordServerCopy(input.draftId, null);
      // Still pointing at the foreign original it continues: the draft now
      // lives beside it, so it stops sharing its Message-ID.
      const original = before.sourceMessageId === null ? null : deps.store.rawRef(before.sourceMessageId);
      if (original !== null && original.folder === before.serverCopy.folder && original.uid === before.serverCopy.uid) {
        deps.store.renewMessageId(input.draftId, newMessageIdFor(deps, requireAccount(deps.store, before.accountId).email));
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
      fromAddress: savedFromAddress(deps.store, before, account, input.fromAddress),
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

/**
 * The draft's From after a save (spec resolution 10): on an account switch,
 * the requested (or current) address only when it is an alias of the new
 * account, else null; on the same account, an explicit address must be one
 * of its active identities (`invalid` otherwise) or the stored From itself,
 * and an absent one keeps the current value. The own address is stored as null.
 */
function savedFromAddress(
  store: MailStore,
  before: DraftRecord,
  account: StoredAccount,
  requested: string | null | undefined,
): string | null {
  const identities = accountIdentities(store, account);
  if (before.accountId !== account.id) {
    const wanted = requested === undefined ? before.fromAddress : requested;
    const identity = wanted === null ? null : identityOf(identities, wanted);
    return identity === null ? null : fromAddressOf(identity);
  }
  if (requested === undefined) return before.fromAddress;
  const identity = identityOf(identities, requested);
  if (identity === null) {
    // The stored From sent back unchanged (an alias removed since): kept, so
    // the draft still saves; the Drafts copy falls back to the own address
    // and a send refuses it with from_unknown.
    if (requested !== null && before.fromAddress !== null && requested.trim().toLowerCase() === before.fromAddress.toLowerCase()) {
      return before.fromAddress;
    }
    throw new ComposeError("invalid");
  }
  return fromAddressOf(identity);
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
  // A hidden draft (an agent proposal's, or an unsubscribe email's) never gets a server copy.
  if (first === null || isHiddenDraft(first)) return "skipped";
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
      if (draft === null || draft.accountId !== first.accountId || isHiddenDraft(draft)) return "skipped";
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
  file: { fileName: string; mimeType: string; size: number; sha256: string; data: Uint8Array; origin?: string | null },
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
    import:
      draft.importHtml === null
        ? null
        : { html: draft.importHtml.html, into: draft.importHtml.into, stripSignature: draft.importHtml.stripSignature ?? false },
    origin: draft.origin,
    fromAddress: draft.fromAddress,
  };
}

/** Every address of the owner (account emails, usernames with `@`, active aliases): never a reply-all recipient. */
export function ownAddresses(store: MailStore): string[] {
  return ownIdentityAddresses(store.listAccounts(), store.listIdentities(null));
}

/** The account's identities: its own address, then its active aliases. */
export function accountIdentities(store: MailStore, account: StoredAccount): Identity[] {
  return identitiesOf(account, store.listIdentities(account.id));
}

/** The draft's identity, or null when its fromAddress is no longer an active identity of its account. */
export function identityOfDraft(store: MailStore, draft: Pick<DraftRecord, "accountId" | "fromAddress">): Identity | null {
  const account = store.getAccount(draft.accountId);
  if (account === null) return null;
  return identityOf(accountIdentities(store, account), draft.fromAddress);
}

function isOwnAddress(store: MailStore, address: string): boolean {
  return ownAddresses(store).includes(address.trim().toLowerCase());
}

/** A continued Drafts message's From as the draft stores it: an identity's address, else null (the own address). */
function continuedFrom(store: MailStore, account: StoredAccount, address: string): string | null {
  const identity = address.trim() === "" ? null : identityOf(accountIdentities(store, account), address);
  return identity === null ? null : fromAddressOf(identity);
}

/** What a draft stores for an identity: null for the own address. */
function fromAddressOf(identity: Identity): string | null {
  return identity.primary ? null : identity.address;
}

/**
 * The message the builder gets for a draft, From its identity. `strict` (a
 * send): every chip must be a valid address, else `invalid`, and a From
 * that is no longer an identity of the account is `from_unknown`.
 * Otherwise (a Drafts copy) invalid chips are left out of the copy (the
 * local row keeps them) and a removed alias falls back to the own address.
 */
export function outgoingOf(
  deps: Pick<ComposeDeps, "store" | "clock">,
  account: StoredAccount,
  draft: DraftRecord,
  strict: boolean,
): OutgoingMessage {
  let identity = identityOf(accountIdentities(deps.store, account), draft.fromAddress);
  if (identity === null) {
    if (strict) throw new ComposeError("from_unknown");
    identity = accountIdentities(deps.store, account)[0]!;
  }
  const from = parseAddress(identity.primary ? account.email : identity.address);
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
  // An invitation answer travels as an alternative of the body, not as a file.
  const calendarAt = draft.purpose === "invite_reply" ? attachments.findIndex((a) => a.mimeType === INVITE_REPLY_MIME) : -1;
  const calendar = calendarAt === -1 ? null : new TextDecoder().decode(attachments.splice(calendarAt, 1)[0]!.bytes);
  return {
    ...(calendar === null ? {} : { calendar: { method: "REPLY" as const, content: calendar } }),
    from: { name: identity.displayName?.trim() || null, address: from.value.address },
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

/** Copies attachments in order while they fit; returns how many were left out. */
async function addWithinCap(store: MailStore, draftId: string, files: OutgoingAttachment[]): Promise<number> {
  let leftOut = 0;
  for (const file of files) {
    const size = file.bytes.length;
    if (size > attachmentRoom(store, draftId)) {
      leftOut += 1;
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

/** `<random@domain>` of the sending address. */
function newMessageIdFor(deps: Pick<ComposeDeps, "newId">, address: string): string {
  const parsed = parseAddress(address);
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

