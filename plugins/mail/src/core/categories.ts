// Categories (slice 3f): four local labels the owner sets, accepts or gets
// from a rule; a local suggestion computed from the row (never stored); the
// rule matching; and the in-memory undo of one labelling call. Pure: no
// IMAP, no keyword or folder, nothing written to a server.
import { isPublicMailDomain, normalizeBlockValue } from "./blocking.ts";
import { isAutomatedAddress } from "./contacts.ts";
import { categorySchema } from "./model.ts";

export const CATEGORIES = categorySchema.options;
export type Category = (typeof CATEGORIES)[number];

/** Who set a label: the owner, or a rule after a sync round. */
export type CategorySource = "owner" | "rule";

export type CategoryRule = {
  id: string;
  kind: "address" | "domain";
  /** Lower case; the domain in ASCII. */
  value: string;
  category: Category;
  createdAt: string;
};

/** Most category rules kept; `category_rule_add` refuses more. */
export const CATEGORY_RULES_MAX = 500;

/**
 * The local suggestion (no model): a bulk row with a list key is a
 * newsletter; bulk or an automated sender without a list, a notification; a
 * sender the owner has written to (not bulk), personal; otherwise none.
 * Bills come only from the model or the owner.
 */
export function localCategory(
  row: { bulk: boolean | null; listKey: string | null; fromAddress: string },
  sentTo: ReadonlySet<string>,
): Category | null {
  const from = row.fromAddress.trim().toLowerCase();
  const listed = row.listKey !== null && row.listKey.trim() !== "";
  if (row.bulk === true && listed) return "newsletters";
  if (row.bulk === true || isAutomatedAddress(from)) return "notifications";
  if (sentTo.has(from)) return "personal";
  return null;
}

function normalizedAddress(address: string): string | null {
  try {
    return normalizeBlockValue("address", address);
  } catch {
    return null;
  }
}

/**
 * The rule a From matches: an address rule exactly first, else the most
 * specific domain rule (the domain or a parent, label by label).
 */
export function ruleMatches<R extends Pick<CategoryRule, "kind" | "value">>(fromAddress: string, rules: readonly R[]): R | null {
  if (rules.length === 0) return null;
  const from = normalizedAddress(fromAddress);
  if (from === null) return null;
  const address = rules.find((rule) => rule.kind === "address" && rule.value === from);
  if (address !== undefined) return address;
  const labels = from.slice(from.lastIndexOf("@") + 1).split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const domain = labels.slice(i).join(".");
    const match = rules.find((rule) => rule.kind === "domain" && rule.value === domain);
    if (match !== undefined) return match;
  }
  return null;
}

/** Why a category rule is refused, or null: an invalid value, or a public mail provider's domain. */
export function categoryRuleRefusal(kind: CategoryRule["kind"], value: string): string | null {
  let normalized: string;
  try {
    normalized = normalizeBlockValue(kind, value);
  } catch {
    return kind === "address" ? "Not a valid address" : "Not a valid domain";
  }
  if (kind === "domain" && isPublicMailDomain(normalized)) {
    return "This is a public mail domain; make a rule for the address instead";
  }
  return null;
}

/** A label before a category call changed it (null: none). */
export type PreviousLabel = {
  accountId: string;
  dedupKey: string;
  category: Category | null;
  source: CategorySource | null;
};

/** How long a category call can be undone. */
export const CATEGORY_UNDO_MS = 10 * 60_000;
const CATEGORY_UNDO_MAX = 100;

/**
 * The previous labels of recent category calls, in memory only, for 10
 * minutes. `take` hands a record back once.
 */
export class CategoryUndoBook {
  private readonly entries = new Map<string, { at: number; previous: PreviousLabel[] }>();

  constructor(
    private readonly newId: () => string,
    private readonly ttlMs: number = CATEGORY_UNDO_MS,
  ) {}

  record(previous: PreviousLabel[], now: Date): string {
    this.sweep(now);
    while (this.entries.size >= CATEGORY_UNDO_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const id = this.newId();
    this.entries.set(id, { at: now.getTime(), previous });
    return id;
  }

  take(id: string, now: Date): PreviousLabel[] | null {
    this.sweep(now);
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    this.entries.delete(id);
    return entry.previous;
  }

  private sweep(now: Date): void {
    for (const [id, entry] of this.entries) {
      if (now.getTime() - entry.at >= this.ttlMs) this.entries.delete(id);
    }
  }
}
