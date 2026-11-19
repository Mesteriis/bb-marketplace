// Instant intro (typing speed): answering an introduction moves the person
// who made it from To to Bcc, so they see the thanks and are spared the rest
// of the conversation. Pure.
import { parseAddress } from "./compose-address.ts";

const INTRO_WORDS = /(^|[^\p{L}])(e-?intro|intro|introduc\p{L}*|meet|connecting you|знаком\p{L}*|познаком\p{L}*|представля\p{L}*|представить)($|[^\p{L}])/iu;
/** How much of the text counts as its beginning. */
const HEAD = 600;

/** Whether a message reads like an introduction: the subject or the first lines say so. */
export function looksLikeIntro(message: { subject: string; text: string }): boolean {
  return INTRO_WORDS.test(message.subject) || INTRO_WORDS.test(message.text.slice(0, HEAD));
}

const keyOf = (recipient: string): string => {
  const parsed = parseAddress(recipient);
  return (parsed.ok ? parsed.value.address : recipient.trim()).toLowerCase();
};

/**
 * The recipients with `sender` moved from To to Bcc. Null when the sender is
 * not in To (already moved, or never there) or when nobody else would be left
 * to write to.
 */
export function moveSenderToBcc(
  draft: { to: readonly string[]; cc: readonly string[]; bcc: readonly string[] },
  sender: string,
): { to: string[]; cc: string[]; bcc: string[] } | null {
  const wanted = keyOf(sender);
  const moved = draft.to.find((recipient) => keyOf(recipient) === wanted);
  if (moved === undefined) return null;
  const to = draft.to.filter((recipient) => keyOf(recipient) !== wanted);
  if (to.length + draft.cc.length === 0) return null;
  const bcc = draft.bcc.some((recipient) => keyOf(recipient) === wanted) ? [...draft.bcc] : [...draft.bcc, moved];
  return { to, cc: [...draft.cc], bcc };
}
