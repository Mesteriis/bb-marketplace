// Gmail labels (slice 3h, #79): X-GM-LABELS as stored (`messages.gm_labels`,
// a JSON array as the server sent it), the owner's labels shown as chips,
// label names the owner may set, and the per-message changes an undo needs
// (spec resolution 10). Pure.

/** Gmail's system labels as X-GM-LABELS reports them; they are roles, not chips. */
export const GMAIL_SYSTEM_LABELS: readonly string[] = [
  "\\Inbox",
  "\\Sent",
  "\\Draft",
  "\\Drafts",
  "\\Important",
  "\\Starred",
  "\\Spam",
  "\\Junk",
  "\\Trash",
  "\\All",
  "\\AllMail",
  "\\Chats",
];

/** Names the owner may not use for a label (compared case-insensitively). */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "inbox",
  "sent",
  "sent mail",
  "draft",
  "drafts",
  "important",
  "starred",
  "spam",
  "junk",
  "trash",
  "bin",
  "all mail",
  "chats",
  "snoozed",
  "scheduled",
]);

export const LABEL_NAME_MAX = 100;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function underGmail(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "[gmail]" || lower === "[google mail]" || lower.startsWith("[gmail]/") || lower.startsWith("[google mail]/");
}

/** A system label: backslash names, the reserved names and anything under [Gmail]. */
export function isSystemLabel(name: string): boolean {
  return name.startsWith("\\") || RESERVED_NAMES.has(name.trim().toLowerCase()) || underGmail(name.trim());
}

/** The stored JSON as label names; nothing for NULL or anything malformed. */
export function parseGmLabels(json: string | null): string[] {
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const value of parsed) {
    if (typeof value === "string" && value !== "" && !out.includes(value)) out.push(value);
  }
  return out;
}

/** The labels shown as chips: system labels left out. */
export function ownerLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => !isSystemLabel(label));
}

export type LabelNameRefusal = "empty" | "too_long" | "control" | "system";

/** A label name the owner may add: 1-100 characters after trim, no control characters, not a system label. */
export function validLabelName(raw: string): { ok: true; name: string } | { ok: false; reason: LabelNameRefusal } {
  const name = raw.trim();
  if (name === "") return { ok: false, reason: "empty" };
  if (name.length > LABEL_NAME_MAX) return { ok: false, reason: "too_long" };
  if (CONTROL.test(name)) return { ok: false, reason: "control" };
  if (isSystemLabel(name)) return { ok: false, reason: "system" };
  return { ok: true, name };
}

export type LabelDelta = { messageId: string; added: string[]; removed: string[] };

/**
 * What a change really does to each message, from its labels before: an
 * added label it already had and a removed label it did not have are left
 * out, as is a label named in both lists. Messages with no change are left
 * out. Undo applies the inverse of exactly these.
 */
export function labelDeltas(
  before: ReadonlyMap<string, readonly string[]>,
  add: readonly string[],
  remove: readonly string[],
): LabelDelta[] {
  const adding = add.filter((label) => !remove.includes(label));
  const removing = remove.filter((label) => !add.includes(label));
  const deltas: LabelDelta[] = [];
  for (const [messageId, labels] of before) {
    const added = [...new Set(adding.filter((label) => !labels.includes(label)))];
    const removed = [...new Set(removing.filter((label) => labels.includes(label)))];
    if (added.length > 0 || removed.length > 0) deltas.push({ messageId, added, removed });
  }
  return deltas;
}
