// Instant intro (typing speed): answering an introduction moves the person
// who made it from To to Bcc, so they see the thanks and are spared the rest
// of the conversation. Pure.
import { parseAddress } from "./compose-address.ts";

// "meet" alone is a meeting; it introduces someone only in "like you to meet", "please meet", "meet Ada".
const INTRO_ANY_CASE =
  /(^|[^\p{L}.\/])(e-?intro|intro|introduc\p{L}*|(like you to|want you to|please|pleased to) meet|connecting you|знакомьтесь|знакомлю|знакомство|познакомьтесь|познакомить|представляю вам|представляю тебе|хочу представить)($|[^\p{L}.\/])/iu;
const MEET_A_NAME = /(^|[^\p{L}.\/])[Mm]eet \p{Lu}\p{Ll}+/u;
/** How much of the text counts as its beginning. */
const HEAD = 600;

/** Whether a message reads like an introduction: the subject or the first lines say so. */
export function looksLikeIntro(message: { subject: string; text: string }): boolean {
  return [message.subject, message.text.slice(0, HEAD)].some((text) => INTRO_ANY_CASE.test(text) || MEET_A_NAME.test(text));
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
  const cc = draft.cc.filter((recipient) => keyOf(recipient) !== wanted);
  if (to.length + cc.length === 0) return null;
  const bcc = draft.bcc.some((recipient) => keyOf(recipient) === wanted) ? [...draft.bcc] : [...draft.bcc, moved];
  return { to, cc, bcc };
}

/**
 * The thank-you line. The people in the conversation read it, so it is in the
 * conversation's language (Russian when the subject is), not the page's.
 */
export function introLine(firstName: string | null, subject: string): string {
  if (/\p{Script=Cyrillic}/u.test(subject)) {
    return firstName === null ? "Спасибо! (Переношу вас в скрытую копию.)" : `Спасибо, ${firstName}! (Переношу вас в скрытую копию.)`;
  }
  return firstName === null ? "Thank you! (Moving you to Bcc.)" : `Thank you, ${firstName}! (Moving you to Bcc.)`;
}
