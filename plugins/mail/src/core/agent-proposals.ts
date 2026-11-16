// Agent proposal use cases (slice 3c): an agent proposes, the owner views the
// card, the card's submit is checked, a confirmed send is queued, a card is
// cancelled or expires. Only `checkSubmit` followed by `queueConfirmed`
// reaches queueSend with origin "agent", and only for the proposal id the
// caller created. Every refusal is a fixed text: never an address, subject,
// body, file name, token or hash. The hidden draft is the only place the
// content lives; the proposal row keeps ids, states and the content hash.
import { z } from "zod";
import {
  AGENT_BODY_MAX_CHARS,
  PROPOSAL_TTL_MS,
  agentQuoteLines,
  checkProposalCaps,
  contentHash,
  linksIn,
  mergeAgentRecipients,
  parseSubmitValue,
  proposalContent,
  recipientFlags,
  refusedHidden,
  revealHidden,
  type ProposalCapHit,
} from "./agent-propose.ts";
import { parseAddress, type AddressProblem, type OutgoingAddress } from "./compose-address.ts";
import {
  DOC_MAX_BYTES,
  docFromLines,
  type ComposeBlock,
  type ComposeDoc,
  type ComposeInline,
  type ComposeListItem,
  type ComposeSignature,
} from "./compose-doc.ts";
import { signatureBlock, signatureText } from "./compose-signature.ts";
import {
  ComposeError,
  MAX_RECIPIENTS,
  accountIdentities,
  createComposeDraft,
  identityOfDraft,
  ownAddresses,
  planCompose,
  planNew,
  sha256Hex,
  type ComposePlan,
} from "./compose.ts";
import { queueSend, type QueueDeps } from "./compose-outbox.ts";
import { headerAddressInput } from "./contract.ts";
import { pickSendingAccount, type AccountCorrespondence, type Owner } from "./contacts.ts";
import { identityOf, ownerAddressSets, type Identity } from "./identities.ts";
import { composeKindSchema, noLineBreaks, type DraftRecord, type MailAddress, type ProposalView } from "./model.ts";
import type { MailStore, ProposalRecord } from "./ports.ts";
import { bbOriginLabels, cardChecks, inheritedSubject, presendIssues } from "./presend.ts";
import { replyToElsewhereOf } from "./sender-view.ts";
import { TEMPLATE_NAME_MAX, templateBlocks, templateNameKey } from "./templates.ts";

export type ProposalDeps = QueueDeps & {
  /** 32 random bytes as unpadded base64url (43 characters). */
  randomToken: () => string;
  /** The vault is open (the account passwords can be read). */
  vaultReady: () => boolean;
};

// ---------------------------------------------------------------------------
// The tool's parameters
// ---------------------------------------------------------------------------

/** The mail_propose tool's parameters (spec "Agent tool"). Recipients refuse CR, LF and NUL at this boundary. */
export const mailProposeParamsSchema = z.object({
  kind: composeKindSchema,
  /** reply / reply_all / forward: a message id from mail_search, mail_read or a mention. */
  sourceMessageId: z.string().min(1).max(200).optional(),
  /**
   * new: the sending account, by id, by its email address or by one of its
   * aliases (which sends from that alias); may be left out (the only
   * account, else the one that corresponds with the To recipients; refused
   * when none does). reply / forward: leave it out (the address the source
   * came to sends; another account or address is refused).
   */
  accountId: z.string().min(1).max(320).optional(),
  to: z.array(headerAddressInput).max(MAX_RECIPIENTS).default([]),
  cc: z.array(headerAddressInput).max(MAX_RECIPIENTS).default([]),
  bcc: z.array(headerAddressInput).max(MAX_RECIPIENTS).default([]),
  /** new: required. reply / forward: defaults to Re: / Fwd: of the source subject. */
  subject: z.string().max(998).refine(noLineBreaks, { message: "Line breaks are not allowed" }).optional(),
  /** Plain text the agent wrote. No HTML, no Markdown rendering. */
  body: z.string().max(AGENT_BODY_MAX_CHARS),
  /** forward only: which of the source's attachments to carry (indexes); default all. */
  forwardAttachments: z.array(z.number().int().min(0)).max(50).optional(),
  /** One of the owner's templates by name (mail_templates): its text follows the body (slice 3d). */
  template: z.string().min(1).max(TEMPLATE_NAME_MAX).optional(),
});
export type MailProposeParams = z.output<typeof mailProposeParamsSchema>;

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type ProposalErrorKind =
  | "off"
  | "vault"
  | "account"
  | "account_required"
  | "account_unknown"
  | "account_mismatch"
  | "smtp_missing"
  | `caps:${ProposalCapHit}`
  | `invalid_address:${AddressProblem}`
  | "too_many_recipients"
  | "no_recipients"
  | "subject_missing"
  | "too_large"
  | "source_not_found"
  | "attachment_index"
  | "hidden_text"
  | "template_unknown";

const ADDRESS_PROBLEM_TEXT: Record<AddressProblem, string> = {
  empty: "it is empty",
  too_long: "it is too long",
  control: "it holds control characters",
  syntax: "it is not an email address",
  non_ascii_local: "its local part is not ASCII",
};

const CAP_TEXT: Record<ProposalCapHit, string> = {
  pending_thread: "A proposal is already waiting for the owner in this thread.",
  pending_total: "Too many proposals are waiting for the owner.",
  thread_hour: "Too many proposals from this thread; ask the owner.",
  total_day: "Too many proposals from this thread; ask the owner.",
  cool_down: "The owner cancelled recent proposals; stop and ask.",
};

const ERROR_TEXT: Record<string, string> = {
  off: "Email proposals are turned off in Mail settings.",
  vault: "Mail is locked; the owner needs to unlock it in Mail.",
  account: "That account cannot send right now; the owner needs to check it in Mail.",
  account_required:
    "The owner has several mail accounts and none has corresponded with these To recipients; pass accountId as one of their addresses.",
  account_unknown: "accountId is not one of the owner's mail accounts; pass one of their addresses.",
  account_mismatch: "A reply or forward is sent from the address the message came to; leave accountId out.",
  smtp_missing: "SMTP is not set for this account.",
  too_many_recipients: `An email can have at most ${MAX_RECIPIENTS} recipients.`,
  no_recipients: "The email has no recipients.",
  subject_missing: "A new email needs a subject.",
  too_large: "The email is too large.",
  source_not_found: "The source message was not found.",
  attachment_index: "An attachment index is not one of the source message's attachments.",
  hidden_text: "The subject or text holds invisible tag or filler characters; write it without them.",
  template_unknown: "No template has that name; call mail_templates for the names.",
};

function errorText(kind: ProposalErrorKind): string {
  if (kind.startsWith("caps:")) return CAP_TEXT[kind.slice("caps:".length) as ProposalCapHit];
  if (kind.startsWith("invalid_address:")) {
    const problem = kind.slice("invalid_address:".length) as AddressProblem;
    return `A recipient address is not valid: ${ADDRESS_PROBLEM_TEXT[problem]}.`;
  }
  return ERROR_TEXT[kind] as string;
}

/** A refusal with a fixed text per kind: never an address, subject or body. */
export class ProposalError extends Error {
  readonly kind: ProposalErrorKind;
  /**
   * `detail` is only ever the owner's own account addresses (for
   * account_required / account_unknown), never message content.
   */
  constructor(kind: ProposalErrorKind, detail?: string) {
    super(detail === undefined ? errorText(kind) : `${errorText(kind)} ${detail}`);
    this.name = "ProposalError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// The agent's fixed sentences
// ---------------------------------------------------------------------------

export type NotQueuedReason = "rate_limited" | "too_large" | "account";

const NOT_QUEUED_TEXT: Record<NotQueuedReason, string> = {
  rate_limited: "too many messages were sent in the last minute",
  too_large: "the attachments are over the size limit",
  account: "the account needs attention in Mail",
};

/** What the tool tells the agent. Fixed text: no recipient, subject, body, token or hash. */
export const AGENT_RESULT = {
  sent: "The owner confirmed the email. It is queued to send, and the owner can still undo it.",
  opened: "The owner opened the email in Mail to edit it. It has not been sent.",
  cancelled: "The owner cancelled the email. Nothing was sent.",
  expired: "The proposal expired before the owner answered. Nothing was sent.",
  changed: "The confirmation did not match the proposal; nothing was sent.",
  notQueued: (reason: NotQueuedReason): string =>
    `The owner confirmed the message, but it could not be queued: ${NOT_QUEUED_TEXT[reason]}. It is kept as a draft in Mail and has not been sent.`,
} as const;

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

/**
 * Creates a proposal: the caps, every agent address through parseAddress,
 * the 3b plan (Reply rules, threading, a forward's attachments), the merge,
 * the recipient count, the subject, the body and its server-built
 * plain-text quote (`importHtml` always null), the size, then one hidden
 * draft (origin "agent", proposal id set), its hash and the `pending` row.
 */
export async function proposeMail(
  deps: ProposalDeps,
  params: MailProposeParams,
  ctx: { threadId: string },
): Promise<{ proposalId: string; contentHash: string }> {
  const now = deps.clock.now();
  if (!deps.vaultReady()) throw new ProposalError("vault");
  const cap = checkProposalCaps(deps.store.proposalCapRows(now.toISOString()), ctx.threadId, now);
  if (cap !== null) throw new ProposalError(`caps:${cap}`);

  const agent = {
    to: parseAll(params.to),
    cc: parseAll(params.cc),
    bcc: parseAll(params.bcc),
  };
  if (params.body.length > AGENT_BODY_MAX_CHARS) throw new ProposalError("too_large");
  // Tag characters and fillers can carry hidden text; they are refused, not only revealed.
  if (refusedHidden(params.body) || (params.subject !== undefined && refusedHidden(params.subject))) {
    throw new ProposalError("hidden_text");
  }
  if (params.kind !== "forward" && params.forwardAttachments !== undefined) {
    throw new ProposalError("attachment_index");
  }

  // The template is resolved by its name key; what is inlined is frozen in the hidden draft.
  const template =
    params.template === undefined ? null : deps.store.getTemplateByKey(templateNameKey(params.template));
  if (params.template !== undefined && template === null) throw new ProposalError("template_unknown");

  let plan: ComposePlan;
  if (params.kind === "new") {
    const owners = ownerAddressSets(deps.store.listAccounts(), deps.store.listIdentities(null));
    const sending = resolveSendingAccount(owners, params.accountId, () =>
      deps.store.correspondence(agent.to.map((a) => a.address)),
    );
    if (params.subject === undefined || params.subject.trim() === "") throw new ProposalError("subject_missing");
    try {
      const account = deps.store.getAccount(sending.accountId);
      const alias =
        account === null || sending.address === null
          ? null
          : identityOf(accountIdentities(deps.store, account), sending.address);
      plan = planNew(deps, sending.accountId, alias === null || alias.primary ? null : alias.address);
    } catch (error) {
      throw asProposalError(error, "account");
    }
  } else {
    if (params.sourceMessageId === undefined) throw new ProposalError("source_not_found");
    try {
      plan = await planCompose(deps, { kind: params.kind, messageId: params.sourceMessageId });
    } catch (error) {
      throw asProposalError(error, "source_not_found");
    }
  }

  const account = deps.store.getAccount(plan.accountId);
  if (account === null || account.authFailed) throw new ProposalError("account");
  if (account.smtp === null) throw new ProposalError("smtp_missing");
  const identity = identityOf(accountIdentities(deps.store, account), plan.fromAddress);
  if (identity === null) throw new ProposalError("account");
  // A reply or forward goes out from the address the source came to (the
  // reply-from rule): its Reply rules and Message-ID domain were computed
  // for it. Naming another account or another of its addresses refuses.
  if (params.kind !== "new" && params.accountId !== undefined && !namesIdentity(params.accountId, account, identity)) {
    throw new ProposalError("account_mismatch");
  }

  const merged = mergeAgentRecipients(params.kind, { to: plan.to, cc: plan.cc }, agent);
  for (const entry of [...merged.to, ...merged.cc, ...merged.bcc]) {
    const parsed = parseAddress(entry.address);
    if (!parsed.ok) throw new ProposalError(`invalid_address:${parsed.problem}`);
  }
  const count = merged.to.length + merged.cc.length + merged.bcc.length;
  if (count === 0) throw new ProposalError("no_recipients");
  if (count > MAX_RECIPIENTS) throw new ProposalError("too_many_recipients");

  const own = new Set(ownAddresses(deps.store));
  const quote =
    params.kind === "new" || plan.original === null
      ? undefined
      : agentQuoteLines(
          plan.original.source,
          params.kind,
          { text: plan.original.text, html: plan.original.html },
          params.kind !== "forward" && own.has(plan.original.source.from.address.trim().toLowerCase()),
        );
  const doc = proposalDoc(params.body, template === null ? null : templateBlocks(template.doc), identity, quote);
  if (new TextEncoder().encode(JSON.stringify(doc)).length > DOC_MAX_BYTES) throw new ProposalError("too_large");

  let attachments = plan.attachments;
  if (params.kind === "forward" && params.forwardAttachments !== undefined) {
    const wanted = [...new Set(params.forwardAttachments)].sort((a, b) => a - b);
    if (wanted.some((index) => index >= plan.attachments.length)) throw new ProposalError("attachment_index");
    attachments = wanted.map((index) => plan.attachments[index]!);
  }

  const proposalId = deps.newId();
  const created = await createComposeDraft(
    deps,
    {
      ...plan,
      to: merged.to.map(asMailAddress),
      cc: merged.cc.map(asMailAddress),
      bcc: merged.bcc.map(asMailAddress),
      subject: params.subject ?? plan.subject,
      doc,
      importHtml: null,
      attachments,
    },
    { origin: "agent", proposalId },
  );
  try {
    const draft = deps.store.getDraft(created.draftId);
    const hash = draft === null ? null : await draftHash(deps.store, draft);
    if (hash === null) throw new ProposalError("account");
    // The caps again, atomically with the insert: the awaits above let
    // concurrent calls past the first check.
    const admit = (rows: Parameters<typeof checkProposalCaps>[0]) => {
      const hit = checkProposalCaps(rows, ctx.threadId, now);
      if (hit !== null) throw new ProposalError(`caps:${hit}`);
    };
    deps.store.createProposal({
      id: proposalId,
      threadId: ctx.threadId,
      draftId: created.draftId,
      accountId: plan.accountId,
      kind: params.kind,
      sourceMessageId: plan.sourceMessageId,
      added: merged.added,
      contentSha256: hash,
      leftOut: created.leftOut,
      templateName: template?.name ?? null,
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    }, admit);
    return { proposalId, contentHash: hash };
  } catch (error) {
    deps.store.deleteDraft(created.draftId);
    throw error;
  }
}

/**
 * The proposal's document (spec resolution 6): the body's lines as
 * paragraphs, then (with a template) an empty paragraph when the body is
 * not empty and the template's blocks, then the identity's signature
 * block, then the quote.
 */
function proposalDoc(
  body: string,
  template: ComposeBlock[] | null,
  identity: Identity,
  quote: string[] | undefined,
): ComposeDoc {
  const bodyEmpty = body.trim() === "";
  const content: (ComposeBlock | ComposeSignature)[] = [];
  if (template === null || !bodyEmpty) {
    content.push(...docFromLines(body.replace(/\r\n?/g, "\n").split("\n")).content);
  }
  if (template !== null) {
    if (!bodyEmpty) content.push({ type: "paragraph" });
    content.push(...template);
  }
  content.push(signatureBlock(identity.signature));
  if (quote !== undefined) content.push(...docFromLines([], quote).content.filter((b) => b.type === "blockquote"));
  return { type: "doc", content };
}

/** The agent's accountId for a reply names the chosen identity: the account's id, or that identity's address. */
function namesIdentity(given: string, account: { id: string; email: string; username: string }, identity: Identity): boolean {
  if (given === account.id) return true;
  const wanted = given.trim().toLowerCase();
  if (!identity.primary) return wanted === identity.address;
  return wanted === account.email.trim().toLowerCase() || wanted === account.username.trim().toLowerCase();
}

function parseAll(list: readonly string[]): OutgoingAddress[] {
  return list.map((typed) => {
    const parsed = parseAddress(typed);
    if (!parsed.ok) throw new ProposalError(`invalid_address:${parsed.problem}`);
    return { name: null, address: parsed.value.address };
  });
}

function asMailAddress(entry: OutgoingAddress): MailAddress {
  return { name: entry.name, address: entry.address };
}

/**
 * The account and identity a new proposal sends from: the given id, or any
 * of an account's addresses (case-insensitive; an alias selects that
 * identity: `address` set, which a username that is no alias also gets, and
 * the caller resolves with identityOf); when none is given, the only account, else the
 * one that corresponds with the To recipients (`history`, read only then),
 * from its own address. `owners` lists each account's addresses, its email
 * first (ownerAddressSets). The agent does not know account ids, so a
 * refusal names the owner's account addresses.
 */
export function resolveSendingAccount(
  owners: readonly Owner[],
  given: string | undefined,
  history: () => readonly AccountCorrespondence[] = () => [],
): { accountId: string; address: string | null } {
  const choices = () => `Accounts: ${owners.map((o) => o.addresses[0] ?? "").join(", ")}.`;
  const own = (accountId: string) => ({ accountId, address: null });
  if (given === undefined) {
    if (owners.length === 1) return own(owners[0]!.id);
    if (owners.length === 0) throw new ProposalError("account");
    // Several accounts: the one that corresponds with the To recipients (pickSendingAccount).
    const picked = pickSendingAccount(owners, history());
    if (picked !== null) return own(picked);
    throw new ProposalError("account_required", choices());
  }
  const byId = owners.find((o) => o.id === given);
  if (byId !== undefined) return own(byId.id);
  const wanted = given.trim().toLowerCase();
  for (const owner of owners) {
    const index = owner.addresses.findIndex((a) => a.trim().toLowerCase() === wanted);
    if (index === -1) continue;
    // The email is the own address; another match (an alias, or a username
    // that is not one) is resolved by the caller against the identities.
    return { accountId: owner.id, address: index === 0 ? null : wanted };
  }
  throw new ProposalError(owners.length === 0 ? "account" : "account_unknown", owners.length === 0 ? undefined : choices());
}

function asProposalError(error: unknown, kind: ProposalErrorKind): Error {
  if (error instanceof ComposeError && error.kind === "not_found") return new ProposalError(kind);
  return error instanceof Error ? error : new ProposalError(kind);
}

/**
 * The From a proposal's draft is sent with (spec resolution 12): its
 * identity's effective name and address; null when the account is gone or
 * the alias was removed.
 */
function draftFrom(store: MailStore, draft: DraftRecord): { name: string | null; address: string; identity: Identity } | null {
  const account = store.getAccount(draft.accountId);
  const identity = identityOfDraft(store, draft);
  if (account === null || identity === null) return null;
  return {
    name: identity.displayName?.trim() || null,
    address: identity.primary ? account.email : identity.address,
    identity,
  };
}

/** The hash of a draft's canonical content as it is stored now, or null when its account or identity is gone. */
export async function draftHash(store: MailStore, draft: DraftRecord): Promise<string | null> {
  const from = draftFrom(store, draft);
  if (from === null) return null;
  return contentHash(proposalContent(draft, from.name, from.address, store.attachmentData(draft.id)));
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export type ProposalViewResult =
  | { state: "ready"; view: ProposalView; viewToken: string }
  | { state: "changed" | "gone" | "opened_elsewhere" };

/**
 * The card's content and a fresh view token. The hash is recomputed from the
 * hidden draft first (spec resolution 14): a draft changed since it was
 * proposed refuses the proposal and drops the draft. Each view replaces the
 * token, so only the latest view can submit; a view after another window
 * already answered the card gets `opened_elsewhere`.
 */
export async function viewProposal(
  deps: Pick<ProposalDeps, "store" | "clock" | "randomToken">,
  input: { proposalId: string; contentHash: string },
): Promise<ProposalViewResult> {
  const proposal = deps.store.getProposal(input.proposalId);
  if (proposal === null) return { state: "gone" };
  if (proposal.state === "confirming" || proposal.state === "queued" || proposal.state === "opened") {
    return { state: "opened_elsewhere" };
  }
  if (proposal.state !== "pending" || proposal.draftId === null) return { state: "gone" };
  const now = deps.clock.now();
  if (now.getTime() >= Date.parse(proposal.expiresAt)) return { state: "gone" };
  if (input.contentHash !== proposal.contentSha256) return { state: "changed" };

  const draft = deps.store.getDraft(proposal.draftId);
  const current = draft === null || draft.proposalId !== proposal.id ? null : await draftHash(deps.store, draft);
  if (draft === null || current !== proposal.contentSha256) {
    refuse(deps.store, proposal.id, ["pending"], now.toISOString());
    return { state: "changed" };
  }

  const token = deps.randomToken();
  const tokenHash = await sha256Hex(new TextEncoder().encode(token));
  if (!deps.store.setViewToken(proposal.id, tokenHash, now.toISOString())) return { state: "gone" };
  return { state: "ready", view: buildView(deps.store, proposal, draft), viewToken: token };
}

function buildView(store: MailStore, proposal: ProposalRecord, draft: DraftRecord): ProposalView {
  const account = store.getAccount(draft.accountId)!;
  // Called after draftHash matched, so the identity is still there.
  const from = draftFrom(store, draft)!;
  const own = ownAddresses(store);
  const ownDomains = own.filter((a) => a.includes("@")).map((a) => a.slice(a.lastIndexOf("@") + 1).toLowerCase());
  const all = [...draft.to, ...draft.cc, ...draft.bcc].map((a) => asciiAddress(a.address));
  const sentTo = store.addressesSentTo(all);
  let hidden = 0;
  const shown = (text: string): string => {
    const revealed = revealHidden(text);
    hidden += revealed.hidden;
    return revealed.shown;
  };
  const row = (list: MailAddress[]) =>
    list.map((entry) => {
      const address = asciiAddress(entry.address);
      return {
        address: shown(address),
        name: entry.name === null ? null : shown(entry.name),
        flags: recipientFlags(address, { sentTo, ownDomains, added: proposal.added }),
      };
    });
  const doc = draft.doc as ComposeDoc;
  const { body, signature, quote } = docParts(doc);
  const signatureShown = signatureText(doc);
  const source = proposal.sourceMessageId === null ? null : store.getMessage(proposal.sourceMessageId);
  const attachments = store.listAttachments(draft.id);
  const reply = draft.kind === "reply" || draft.kind === "reply_all";
  const checks = cardChecks(
    presendIssues({
      kind: draft.kind,
      subject: draft.subject,
      doc,
      attachmentCount: attachments.length,
      bbOrigins: bbOriginLabels(attachments),
      recipients: all,
      own: new Set(own),
      sentTo,
      conversation: reply && draft.sourceMessageId !== null ? store.conversationAddresses(draft.sourceMessageId) : null,
      replyToElsewhere: reply && draft.sourceMessageId !== null ? replyToElsewhereOf(store, draft.sourceMessageId, new Set(own)) : [],
      inheritedSubject: inheritedSubject(
        draft.kind,
        draft.sourceMessageId === null ? null : (store.getMessage(draft.sourceMessageId)?.subject ?? null),
      ),
    }),
  );
  const view: ProposalView = {
    proposalId: proposal.id,
    draftId: draft.id,
    kind: draft.kind,
    account: { id: account.id, name: account.displayName?.trim() || account.email, address: from.address },
    fromName: from.name,
    source: source === null ? null : { fromAddress: source.from.address, subject: shown(source.subject) },
    to: row(draft.to),
    cc: row(draft.cc),
    bcc: row(draft.bcc),
    subject: shown(draft.subject),
    hiddenChars: 0,
    bodyText: shown(body),
    quoteText: quote === null ? null : shown(quote),
    links: cardLinks(`${body}\n${signature}`, doc),
    attachments: attachments.map((a) => ({ fileName: a.fileName, mimeType: a.mimeType, size: a.size })),
    leftOut: proposal.leftOut,
    expiresAt: proposal.expiresAt,
    fromAlias: !from.identity.primary,
    signatureText: signatureShown === null ? null : shown(signatureShown),
    templateName: proposal.templateName === null ? null : shown(proposal.templateName),
    checks,
  };
  view.hiddenChars = hidden;
  return view;
}

function asciiAddress(address: string): string {
  const parsed = parseAddress(address);
  return parsed.ok ? parsed.value.address : address;
}

/**
 * The agent's text with any template (blocks other than the signature and
 * the quote), the signature's text, and the quote's text, one line per
 * paragraph (spec resolution 12).
 */
function docParts(doc: ComposeDoc): { body: string; signature: string; quote: string | null } {
  const body: string[] = [];
  const signature: string[] = [];
  let quote: string[] | null = null;
  for (const block of doc.content) {
    if (block.type === "blockquote") {
      quote = [...(quote ?? []), ...block.content.map(blockText)];
    } else if (block.type === "signature") {
      signature.push(...block.content.map(blockText));
    } else {
      body.push(blockText(block));
    }
  }
  return { body: body.join("\n"), signature: signature.join("\n"), quote: quote === null ? null : quote.join("\n") };
}

/**
 * The card's links: those written in the body, template and signature text,
 * and the `href` of every link mark outside the quote, once each.
 */
function cardLinks(text: string, doc: ComposeDoc): { url: string; host: string }[] {
  const found = linksIn(text);
  const seen = new Set(found.map((l) => l.url));
  const hrefs: string[] = [];
  const walk = (nodes: readonly (ComposeBlock | ComposeListItem | ComposeSignature | ComposeInline)[]) => {
    for (const node of nodes) {
      if (node.type === "blockquote") continue;
      if (node.type === "text") {
        for (const mark of node.marks ?? []) if (mark.type === "link") hrefs.push(mark.attrs.href);
      } else if (node.type !== "hardBreak") {
        walk((node.content ?? []) as (ComposeBlock | ComposeListItem | ComposeSignature | ComposeInline)[]);
      }
    }
  };
  walk(doc.content);
  for (const href of hrefs) {
    for (const link of linksIn(href)) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      found.push(link);
    }
  }
  return found;
}

function blockText(block: ComposeBlock | ComposeListItem | ComposeSignature): string {
  if (block.type === "paragraph") {
    return (block.content ?? []).map((inline) => (inline.type === "text" ? inline.text : "\n")).join("");
  }
  return (block.content as (ComposeBlock | ComposeListItem)[]).map(blockText).join("\n");
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

/**
 * `retry`: the submit carried an older view's token (another view rotated
 * it); the proposal is back to `pending` with its draft, and the card can be
 * opened again.
 */
export type SubmitCheck = { action: "send" | "open" } | { refused: "changed" } | { retry: "opened_elsewhere" };

/**
 * The card's submit check (spec resolution 8), run once: the strict parse,
 * the proposal id this tool call created (the closure's, not the value's),
 * CAS pending → confirming (a second submit loses), the submitted hash equal
 * to the stored one and to the hash of the current hidden draft, the latest
 * view's token, and expiry. "open" releases the draft (an owner draft, the
 * proposal `opened`) within the same call. A content failure after the parse
 * refuses the proposal and drops its hidden draft; a lost race leaves the
 * winner alone; a token that is not the latest view's (spec resolution 21)
 * is no content change: the proposal goes back to `pending` with its draft,
 * which does not count toward the cool-down.
 */
export async function checkSubmit(
  deps: Pick<ProposalDeps, "store" | "clock">,
  proposalId: string,
  value: unknown,
): Promise<SubmitCheck> {
  const at = () => deps.clock.now().toISOString();
  const fail = (from: ("pending" | "confirming")[]): SubmitCheck => {
    refuse(deps.store, proposalId, from, at());
    return { refused: "changed" };
  };
  const submitted = parseSubmitValue(value);
  if (submitted === null || submitted.proposalId !== proposalId) return fail(["pending"]);
  if (!deps.store.transitionProposal(proposalId, ["pending"], "confirming", at())) return { refused: "changed" };

  const proposal = deps.store.getProposal(proposalId);
  if (proposal === null || proposal.draftId === null) return fail(["confirming"]);
  if (submitted.contentHash !== proposal.contentSha256) return fail(["confirming"]);
  const draft = deps.store.getDraft(proposal.draftId);
  if (draft === null || draft.proposalId !== proposalId) return fail(["confirming"]);
  if ((await draftHash(deps.store, draft)) !== proposal.contentSha256) return fail(["confirming"]);
  if (deps.clock.now().getTime() >= Date.parse(proposal.expiresAt)) {
    deps.store.transitionProposal(proposalId, ["confirming"], "expired", at());
    deps.store.dropProposalDraft(proposalId);
    return { refused: "changed" };
  }
  const tokenHash = await sha256Hex(new TextEncoder().encode(submitted.viewToken));
  if (proposal.viewTokenSha256 === null || tokenHash !== proposal.viewTokenSha256) {
    // Nothing changed but the view: back to pending, the draft kept.
    deps.store.transitionProposal(proposalId, ["confirming"], "pending", at());
    return { retry: "opened_elsewhere" };
  }

  if (submitted.action === "open") {
    if (!deps.store.releaseProposalDraft(proposalId, draft.id, at())) return { refused: "changed" };
    return { action: "open" };
  }
  return { action: "send" };
}

/** Refuses the proposal (from `from` only) and, when that won, drops its hidden draft. */
function refuse(store: MailStore, proposalId: string, from: ("pending" | "confirming")[], at: string): void {
  if (store.transitionProposal(proposalId, from, "refused", at)) store.dropProposalDraft(proposalId);
}

/** What the host persists for the settled card: a title true at the time and the proposal id only. */
export function describeProposalSubmission(
  proposalId: string,
  result: SubmitCheck,
): { title: string; payload: { proposalId: string } } {
  const title =
    "refused" in result
      ? "Not sent: the proposal changed"
      : "retry" in result
        ? "Not sent: this card was opened elsewhere; reopen it"
        : result.action === "open"
        ? "Opened in Mail"
        : "Email confirmed";
  return { title, payload: { proposalId } };
}

// ---------------------------------------------------------------------------
// Queue, cancel
// ---------------------------------------------------------------------------

/**
 * After a confirmed "send": the vault, sign-in and SMTP checks again, then
 * queueSend of the hidden draft with requestId = proposalId and origin
 * "agent", and the proposal `queued` with its outbox id. A refusal keeps the
 * message as an owner draft (released, proposal `opened`) and says why. A
 * confirmed proposal whose hidden draft is gone is settled `expired`
 * (`lost`), so it never stays `confirming`.
 */
export async function queueConfirmed(
  deps: ProposalDeps,
  proposalId: string,
): Promise<{ outboxId: string } | { notQueued: NotQueuedReason } | { lost: true } | { refused: "changed" }> {
  const at = () => deps.clock.now().toISOString();
  const proposal = deps.store.getProposal(proposalId);
  if (proposal === null || proposal.state !== "confirming") return { notQueued: "account" };
  const lost = (): { lost: true } => {
    cancelProposal(deps, proposalId, "expired");
    return { lost: true };
  };
  if (proposal.draftId === null) return lost();
  const draftId = proposal.draftId;
  const release = (reason: NotQueuedReason) => {
    deps.store.releaseProposalDraft(proposalId, draftId, at());
    return { notQueued: reason };
  };
  const draft = deps.store.getDraft(draftId);
  if (draft === null || draft.proposalId !== proposalId) return lost();
  const account = deps.store.getAccount(draft.accountId);
  if (!deps.vaultReady() || account === null || account.authFailed || account.smtp === null) {
    return release("account");
  }
  // The From the owner confirmed is part of the hash: the account's name
  // and address now must still hash to it, and queueSend must use them.
  const changed = (): { refused: "changed" } => {
    refuse(deps.store, proposalId, ["confirming"], at());
    return { refused: "changed" };
  };
  const sender = draftFrom(deps.store, draft);
  if (sender === null) return changed();
  const from = { name: sender.name, address: sender.address };
  const hashed = await contentHash(proposalContent(draft, from.name, from.address, deps.store.attachmentData(draft.id)));
  if (hashed !== proposal.contentSha256) return changed();
  let outboxId: string;
  try {
    ({ outboxId } = await queueSend(deps, {
      draftId,
      baseRevision: draft.revision,
      requestId: proposalId,
      origin: "agent",
      expectFrom: from,
    }));
  } catch (error) {
    const kind = error instanceof ComposeError ? error.kind : null;
    // expectFrom's refusal: the account or identity changed between the hash and the build.
    const now = draftFrom(deps.store, draft);
    const sameFrom =
      now !== null && now.name === from.name && now.address.trim().toLowerCase() === from.address.trim().toLowerCase();
    if ((kind === "conflict" || kind === "from_unknown") && !sameFrom) return changed();
    return release(kind === "rate_limited" ? "rate_limited" : kind === "too_large" ? "too_large" : "account");
  }
  deps.store.transitionProposal(proposalId, ["confirming"], "queued", at(), { outboxId });
  return { outboxId };
}

/**
 * The card was cancelled (by the owner) or ran out (timeout, restart,
 * plugin disposed), or a confirmed one cannot go on: the proposal is
 * `cancelled` or `expired` from `pending` or `confirming` (a confirmed card
 * nobody queues must not block the caps), and its hidden draft deleted.
 * False when the proposal had already settled.
 */
export function cancelProposal(
  deps: Pick<ProposalDeps, "store" | "clock">,
  proposalId: string,
  reason: "user" | "expired",
): boolean {
  const at = deps.clock.now().toISOString();
  const moved = deps.store.transitionProposal(
    proposalId,
    ["pending", "confirming"],
    reason === "user" ? "cancelled" : "expired",
    at,
  );
  if (moved) deps.store.dropProposalDraft(proposalId);
  return moved;
}
