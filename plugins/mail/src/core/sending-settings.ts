// Owner settings for sending (slice 3d): the identities of each account
// (the own address and its aliases), alias suggestions, templates, and the
// advisory pre-send check of a saved draft. Only the owner's RPCs call these;
// nothing here adds an identity on its own (suggestions only list).
import { TEMPLATE_FILES_MAX, TEMPLATE_FILES_MAX_BYTES, normalizeExtras, type TemplateExtras } from "./snippets.ts";
import type { TemplateFileInfo } from "./ports.ts";
import { parseAddress } from "./compose-address.ts";
import { normalizeSignature } from "./compose-signature.ts";
import { ComposeError, accountIdentities, addComposeAttachment, attachmentRoom, ownAddresses, requireAccount } from "./compose.ts";

type ComposeAttachment = ReturnType<typeof addComposeAttachment>;
import type { ComposeDoc } from "./compose-doc.ts";
import {
  PROVIDER_DOMAINS,
  aliasSuggestions,
  type AliasSuggestion,
  type Identity,
} from "./identities.ts";
import type { DraftRecord, StoredAccount } from "./model.ts";
import type { MailStore } from "./ports.ts";
import { bbOriginLabels, inheritedSubject, presendIssues, type PresendIssue } from "./presend.ts";
import { replyToElsewhereOf, type KnownSource } from "./sender-view.ts";
import { normalizeTemplate, templateName, templateNameKey } from "./templates.ts";

/**
 * A refusal whose text may name one of the owner's own accounts: it goes to
 * the owner's page only, never to logs, realtime or agents.
 */
export class IdentityRefusal extends Error {
  readonly kind: "conflict" | "invalid" | "not_found";
  constructor(kind: "conflict" | "invalid" | "not_found", text: string) {
    super(text);
    this.name = "IdentityRefusal";
    this.kind = kind;
  }
}

export const UNKNOWN_ACCOUNT_TEXT = "Unknown account";
export const UNKNOWN_ADDRESS_TEXT = "Unknown address";
export const OWN_ADDRESS_SIGNATURE_ONLY = "The account's own address takes a signature only; its name is the account's";
export const OWN_ADDRESS_NOT_REMOVABLE = "The account's own address cannot be removed";
export const IDENTITIES_FULL_TEXT = "This account already has 50 addresses";
export const TEMPLATE_NAME_TAKEN = "A template with this name exists";
export const UNKNOWN_TEMPLATE_TEXT = "Unknown template";

export type IdentityView = Pick<Identity, "accountId" | "address" | "displayName" | "primary" | "signature" | "sendCheck">;

const lower = (address: string) => address.trim().toLowerCase();

function view(identity: Identity): IdentityView {
  return {
    accountId: identity.accountId,
    address: identity.address,
    displayName: identity.displayName,
    primary: identity.primary,
    signature: identity.signature,
    sendCheck: identity.sendCheck,
  };
}

function accountOf(store: MailStore, accountId: string): StoredAccount {
  const account = store.getAccount(accountId);
  if (account === null) throw new IdentityRefusal("not_found", UNKNOWN_ACCOUNT_TEXT);
  return account;
}

function identityViewOf(store: MailStore, account: StoredAccount, address: string): IdentityView {
  const found = accountIdentities(store, account).find((identity) => identity.address === lower(address));
  if (found === undefined) throw new IdentityRefusal("not_found", UNKNOWN_ADDRESS_TEXT);
  return view(found);
}

function isPrimary(store: MailStore, account: StoredAccount, address: string): boolean {
  return accountIdentities(store, account).some((identity) => identity.primary && identity.address === lower(address));
}

/** The address part of what the page sent, lower case; refuses anything that is not one address. */
function addressOf(input: string): string {
  const parsed = parseAddress(input);
  if (!parsed.ok) throw new ComposeError("invalid");
  return lower(parsed.value.address);
}

export function listIdentityViews(store: MailStore, accountId: string | null): IdentityView[] {
  const accounts = accountId === null ? store.listAccounts() : [accountOf(store, accountId)];
  return accounts.flatMap((account) => accountIdentities(store, account).map(view));
}

/** The account that already owns the address (own address, username or active alias), if any. */
function ownerOf(store: MailStore, address: string): StoredAccount | null {
  for (const account of store.listAccounts()) {
    if ([account.email, account.username].map(lower).includes(address)) return account;
  }
  const alias = store.listIdentities(null).find((row) => row.state === "active" && row.address === address);
  return alias === undefined ? null : store.getAccount(alias.accountId);
}

export function addIdentity(
  store: MailStore,
  input: { accountId: string; address: string; displayName?: string | undefined },
  nowIso: string,
): IdentityView {
  const account = accountOf(store, input.accountId);
  const address = addressOf(input.address);
  const displayName = input.displayName === undefined || input.displayName.trim() === "" ? null : input.displayName.trim();
  try {
    store.upsertIdentity({ accountId: account.id, address, displayName }, nowIso);
  } catch (error) {
    if (!(error instanceof ComposeError) || error.kind !== "conflict") throw error;
    const owner = ownerOf(store, address);
    if (owner !== null && owner.id !== account.id) throw new IdentityRefusal("conflict", `This address belongs to ${owner.email}`);
    if (owner !== null) throw new IdentityRefusal("conflict", "This is the account's own address");
    throw new IdentityRefusal("conflict", IDENTITIES_FULL_TEXT);
  }
  return identityViewOf(store, account, address);
}

export function updateIdentity(
  store: MailStore,
  input: { accountId: string; address: string; displayName?: string | null | undefined; signature?: unknown },
  nowIso: string,
): IdentityView {
  const account = accountOf(store, input.accountId);
  const address = addressOf(input.address);
  const signature =
    input.signature === undefined ? undefined : input.signature === null ? null : emptyToNull(normalizeSignature(input.signature));
  if (isPrimary(store, account, address)) {
    if (input.displayName !== undefined) throw new IdentityRefusal("invalid", OWN_ADDRESS_SIGNATURE_ONLY);
    if (signature !== undefined) store.setAccountSignature(account.id, signature);
    return identityViewOf(store, requireAccount(store, account.id), address);
  }
  const patch: { displayName?: string | null; signature?: ReturnType<typeof emptyToNull> } = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName === null || input.displayName.trim() === "" ? null : input.displayName.trim();
  if (signature !== undefined) patch.signature = signature;
  if (store.updateIdentity(account.id, address, patch, nowIso) === null) throw new IdentityRefusal("not_found", UNKNOWN_ADDRESS_TEXT);
  return identityViewOf(store, account, address);
}

/** A signature with no paragraphs is stored as none. */
function emptyToNull(signature: ReturnType<typeof normalizeSignature>): ReturnType<typeof normalizeSignature> | null {
  return signature.content.length === 0 ? null : signature;
}

export function removeIdentity(store: MailStore, input: { accountId: string; address: string }): { ok: true } {
  const account = accountOf(store, input.accountId);
  const address = addressOf(input.address);
  if (isPrimary(store, account, address)) throw new IdentityRefusal("invalid", OWN_ADDRESS_NOT_REMOVABLE);
  if (!store.removeIdentity(account.id, address)) throw new IdentityRefusal("not_found", UNKNOWN_ADDRESS_TEXT);
  return { ok: true };
}

export function dismissIdentity(store: MailStore, input: { accountId: string; address: string }, nowIso: string): { ok: true } {
  const account = accountOf(store, input.accountId);
  store.dismissIdentity(account.id, addressOf(input.address), nowIso);
  return { ok: true };
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** Addresses that look like the account's, from its inbound mail; lists only, adds nothing. */
export function identitySuggestions(store: MailStore, accountId: string): AliasSuggestion[] {
  const account = accountOf(store, accountId);
  const known = new Set(ownAddresses(store));
  const dismissed = new Set(
    store
      .listIdentities(account.id)
      .filter((row) => row.state === "dismissed")
      .map((row) => row.address),
  );
  const ownDomains = [
    ...new Set(
      accountIdentities(store, account)
        .map((identity) => identity.address)
        .filter((address) => address.includes("@"))
        .map(domainOf),
    ),
  ];
  return aliasSuggestions(store.inboundAddressRows(account.id), known, dismissed, ownDomains, PROVIDER_DOMAINS[account.preset]);
}

export type TemplateView = TemplateExtras & { id: string; name: string; doc: ComposeDoc; updatedAt: string; files: TemplateFileInfo[] };

export function listTemplateViews(store: MailStore): TemplateView[] {
  return store.listTemplates().map((row) => ({
    id: row.id,
    name: row.name,
    doc: row.doc,
    updatedAt: row.updatedAt,
    subject: row.subject,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    files: row.files,
  }));
}

/** How many more bytes a template's files may take; throws `not_found` for an unknown template and `conflict` at five files. */
export function templateFileRoom(store: MailStore, templateId: string): number {
  const template = store.listTemplates().find((row) => row.id === templateId);
  if (template === undefined) throw new IdentityRefusal("not_found", UNKNOWN_TEMPLATE_TEXT);
  if (template.files.length >= TEMPLATE_FILES_MAX) throw new IdentityRefusal("conflict", "A template holds at most 5 files");
  return Math.max(0, TEMPLATE_FILES_MAX_BYTES - template.files.reduce((sum, file) => sum + file.size, 0));
}

/**
 * Typing speed: attaches a template's files to a draft, each whole or not at
 * all. A file with no room left in the message is named in `leftOut`.
 */
export function applyTemplate(store: MailStore, draftId: string, templateId: string): { attached: ComposeAttachment[]; leftOut: string[] } {
  if (!store.listTemplates().some((row) => row.id === templateId)) throw new IdentityRefusal("not_found", UNKNOWN_TEMPLATE_TEXT);
  const attached: ComposeAttachment[] = [];
  const leftOut: string[] = [];
  // A file the draft already carries (the template applied a second time) is not attached again.
  const present = new Set(store.listAttachments(draftId).map((a) => `${a.fileName}\u0000${a.size}\u0000${a.mimeType}`));
  for (const file of store.templateFiles(templateId)) {
    if (present.has(`${file.name}\u0000${file.size}\u0000${file.mimeType}`)) continue;
    if (file.size > attachmentRoom(store, draftId)) {
      leftOut.push(file.name);
      continue;
    }
    attached.push(addComposeAttachment(store, draftId, { fileName: file.name, mimeType: file.mimeType, size: file.size, sha256: file.sha256, data: file.data }));
  }
  return { attached, leftOut };
}

export function saveTemplate(
  store: MailStore,
  input: { id?: string | undefined; name: string; doc: unknown; subject?: unknown; to?: unknown; cc?: unknown; bcc?: unknown },
  newId: string,
  nowIso: string,
): { id: string } {
  const name = templateName(input.name);
  const doc = normalizeTemplate(input.doc);
  // A save that names none of them (an older page, an agent's tool) leaves the template's subject and recipients alone.
  const named = input.subject !== undefined || input.to !== undefined || input.cc !== undefined || input.bcc !== undefined;
  const extras = named ? normalizeExtras({ subject: input.subject, to: input.to, cc: input.cc, bcc: input.bcc }) : undefined;
  const saved = store.saveTemplate(
    { id: input.id ?? null, name, nameKey: templateNameKey(name), doc, ...(extras !== undefined ? { extras } : {}) },
    newId,
    nowIso,
  );
  if ("conflict" in saved) throw new IdentityRefusal("conflict", TEMPLATE_NAME_TAKEN);
  return saved;
}

export function deleteTemplate(store: MailStore, id: string): { ok: true } {
  if (!store.deleteTemplate(id)) throw new IdentityRefusal("not_found", UNKNOWN_TEMPLATE_TEXT);
  return { ok: true };
}

/**
 * The advisory issues of the saved draft (spec "Pre-send check"); `conflict`
 * when the page's revision is not the saved one. Never refuses a send.
 */
export function checkDraft(
  store: MailStore,
  draft: DraftRecord,
  baseRevision: number,
  projectNames?: ReadonlyMap<string, string>,
  known?: KnownSource,
): PresendIssue[] {
  if (draft.revision !== baseRevision) throw new ComposeError("conflict");
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc].map((a) => a.address);
  const reply = draft.kind === "reply" || draft.kind === "reply_all";
  const attachments = store.listAttachments(draft.id);
  const own = new Set(ownAddresses(store));
  return presendIssues({
    kind: draft.kind,
    subject: draft.subject,
    doc: draft.doc,
    attachmentCount: attachments.length,
    bbOrigins: bbOriginLabels(attachments, projectNames),
    recipients,
    own,
    sentTo: store.addressesSentTo(recipients),
    conversation: reply && draft.sourceMessageId !== null ? store.conversationAddresses(draft.sourceMessageId) : null,
    inheritedSubject: inheritedSubject(draft.kind, sourceSubject(store, draft)),
    // Slice 3i (resolution 17): the source's flagged Reply-To addresses, computed here, not in the page.
    replyToElsewhere: reply && draft.sourceMessageId !== null ? replyToElsewhereOf(store, draft.sourceMessageId, own, known) : [],
  });
}

/** The stored source message's subject, for the inherited Re:/Fwd: subject; null when it is gone. */
function sourceSubject(store: MailStore, draft: Pick<DraftRecord, "kind" | "sourceMessageId">): string | null {
  if (draft.kind === "new" || draft.sourceMessageId === null) return null;
  return store.getMessage(draft.sourceMessageId)?.subject ?? null;
}
