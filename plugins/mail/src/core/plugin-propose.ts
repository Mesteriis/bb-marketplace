// A letter another plugin prepares (the plugin API, right "mail.propose"):
// an ordinary draft of the account, marked with the plugin that wrote it.
// Nothing here queues a send: the owner opens the draft in the composer and
// sends it, or does not. Recipients and text are the plugin's data, kept as
// they are; the account's signature is added like in any new letter.
import { parseAddress } from "./compose-address.ts";
import { DOC_MAX_BYTES, docFromLines } from "./compose-doc.ts";
import { createComposeDraft, MAX_RECIPIENTS, planNew, type ComposeDeps } from "./compose.ts";
import { PROPOSALS_PER_DAY, overDailyLimit } from "./plugin-access.ts";

export type PluginLetter = { accountId: string; to: string[]; cc: string[]; subject: string; text: string };

export type PluginProposeRefusal = "account" | "address" | "no_recipients" | "too_many_recipients" | "too_large" | "limit";

export const PROPOSE_REFUSAL_TEXT: Record<PluginProposeRefusal, string> = {
  account: "Unknown account",
  address: "A recipient's address is not valid",
  no_recipients: "The letter has no recipient",
  too_many_recipients: "Too many recipients",
  too_large: "The letter is too large",
  limit: "Too many proposed letters today",
};

export async function proposePluginLetter(
  deps: Pick<ComposeDeps, "store" | "newId" | "clock">,
  pluginId: string,
  letter: PluginLetter,
): Promise<{ ok: true; draftId: string } | { ok: false; reason: PluginProposeRefusal }> {
  const now = deps.clock.now();
  if (overDailyLimit(deps.store.pluginDraftTimes(pluginId), now, PROPOSALS_PER_DAY)) return { ok: false, reason: "limit" };
  if (deps.store.getAccount(letter.accountId) === null) return { ok: false, reason: "account" };
  const count = letter.to.length + letter.cc.length;
  if (letter.to.length === 0) return { ok: false, reason: "no_recipients" };
  if (count > MAX_RECIPIENTS) return { ok: false, reason: "too_many_recipients" };
  const parse = (entries: string[]) =>
    entries.map((entry) => {
      const parsed = parseAddress(entry);
      return parsed.ok ? { name: parsed.value.name, address: parsed.value.address } : null;
    });
  const to = parse(letter.to);
  const cc = parse(letter.cc);
  if ([...to, ...cc].some((entry) => entry === null)) return { ok: false, reason: "address" };

  const plan = planNew(deps, letter.accountId, null);
  const body = docFromLines(letter.text.replace(/\r\n?/g, "\n").split("\n")).content;
  // The plan's own document holds the account's signature; the plugin's text goes above it.
  const doc = { ...plan.doc, content: [...body, ...plan.doc.content] };
  if (new TextEncoder().encode(JSON.stringify(doc)).length > DOC_MAX_BYTES) return { ok: false, reason: "too_large" };
  const created = await createComposeDraft(
    deps,
    { ...plan, to: to as NonNullable<(typeof to)[number]>[], cc: cc as NonNullable<(typeof cc)[number]>[], subject: letter.subject, doc, importHtml: null },
    { origin: "owner", proposalId: null },
  );
  deps.store.markDraftPreparedBy(created.draftId, pluginId);
  return { ok: true, draftId: created.draftId };
}
