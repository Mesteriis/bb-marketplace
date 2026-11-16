// Slice 3i: what a stored message's sender check, disguise warnings, receipt
// request and signed or encrypted kind look like to the reading pane, agents
// and pre-send. Read from the stored columns (`senderCheckRows`) at read
// time; disguise warnings are never stored (part A resolution 5). Pure over
// the store port.
import type { MailCrypto } from "./mail-crypto.ts";
import type { SenderCheckView } from "./model.ts";
import type { MailStore, SenderCheckRow } from "./ports.ts";
import { readStoredCheck, senderCheckSummary, type SenderCheck } from "./sender-check.ts";
import { buildKnownDomains, disguiseWarnings, KNOWN_DOMAINS_MAX, type DisguiseWarning, type KnownDomains } from "./sender-disguise.ts";

/** The 3i header fields of one stored message, with the full check for Details and automatic images. */
export type SecurityView = {
  check: SenderCheck;
  senderCheck: SenderCheckView;
  warnings: DisguiseWarning[];
  receiptRequested: boolean;
  crypto: MailCrypto | null;
};

/** The known-domain set of the lookalike and Reply-To checks, from one store query. */
export function knownDomainsOf(store: Pick<MailStore, "knownDomainList">): KnownDomains {
  return buildKnownDomains(store.knownDomainList(KNOWN_DOMAINS_MAX));
}

/** The known set, built only when a message needs it (most have no Reply-To and a known From). */
export type KnownSource = KnownDomains | (() => KnownDomains);

const OWN_ROLES = new Set(["sent", "drafts"]);

/** One stored row's view. A Sent or Drafts copy gets no warnings, whatever its stored check says. */
export function securityViewOf(
  row: SenderCheckRow,
  context: { preset: Parameters<typeof readStoredCheck>[1]; known: KnownDomains; own: ReadonlySet<string> },
): SecurityView {
  const check = readStoredCheck(row.senderCheckJson, context.preset);
  const warnings =
    row.folderRole !== null && OWN_ROLES.has(row.folderRole)
      ? []
      : disguiseWarnings({
          from: row.from,
          replyTo: row.replyTo ?? [],
          bulk: row.bulk === true,
          listId: row.listId,
          check,
          known: context.known,
          own: context.own,
        });
  return {
    check,
    senderCheck: { state: check.state, summary: senderCheckSummary(check) },
    warnings,
    receiptRequested: row.receiptRequested === true,
    crypto: row.crypto,
  };
}

/** The views of these stored messages by id; unknown ids are left out. */
export function securityViews(
  store: Pick<MailStore, "senderCheckRows" | "getAccount">,
  ids: readonly string[],
  context: { known: KnownDomains; own: ReadonlySet<string> },
): Map<string, SecurityView> {
  const presets = new Map<string, Parameters<typeof readStoredCheck>[1]>();
  const out = new Map<string, SecurityView>();
  for (const row of store.senderCheckRows([...ids])) {
    let preset = presets.get(row.accountId);
    if (preset === undefined) {
      preset = store.getAccount(row.accountId)?.preset ?? "other";
      presets.set(row.accountId, preset);
    }
    out.set(row.id, securityViewOf(row, { preset, known: context.known, own: context.own }));
  }
  return out;
}

/**
 * The source message's `reply_to_elsewhere` addresses (part A resolution 17),
 * for pre-send: empty when the source is gone, is own mail or has no such
 * warning. The known set is built only when the source has a Reply-To.
 */
export function replyToElsewhereOf(
  store: Pick<MailStore, "senderCheckRows" | "getAccount" | "knownDomainList">,
  sourceMessageId: string,
  own: ReadonlySet<string>,
  known?: KnownSource,
): string[] {
  const [row] = store.senderCheckRows([sourceMessageId]);
  if (row === undefined || row.replyTo === null || row.replyTo.length === 0) return [];
  const set = known === undefined ? knownDomainsOf(store) : typeof known === "function" ? known() : known;
  const view = securityViewOf(row, { preset: store.getAccount(row.accountId)?.preset ?? "other", known: set, own });
  const warning = view.warnings.find((entry) => entry.kind === "reply_to_elsewhere");
  return warning?.kind === "reply_to_elsewhere" ? warning.addresses : [];
}

/** The ids among these whose stored check failed (agent Inbox rows carry only this marker, resolution 15). */
export function failedSenderIds(store: Pick<MailStore, "senderCheckRows" | "getAccount">, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const row of store.senderCheckRows([...ids])) {
    if (row.senderCheckJson === null) continue;
    if (readStoredCheck(row.senderCheckJson, store.getAccount(row.accountId)?.preset ?? "other").state === "failed") out.add(row.id);
  }
  return out;
}
