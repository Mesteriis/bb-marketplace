// Which ChatGPT conversation a Browser tab shows, derived only from the URL
// the host reports for the tab's top-level document. A tab title, the focus
// or an earlier URL never identify a conversation.

export const CHATGPT_ORIGIN = "https://chatgpt.com";

/** One existing conversation: the exact origin plus its canonical path. */
export interface ConversationTarget {
  readonly origin: typeof CHATGPT_ORIGIN;
  /** `/c/<id>` or `/g/<project>/c/<id>`. */
  readonly path: string;
}

export type TargetRefusal =
  /** The address is not a well-formed URL. */
  | "invalid-url"
  /** Another site, scheme, port or a URL carrying credentials. */
  | "not-chatgpt"
  /** ChatGPT, but no existing conversation: a new chat, the sign-in page, settings. */
  | "no-conversation";

export type TargetResult = { ok: true; target: ConversationTarget } | { ok: false; reason: TargetRefusal };

const CONVERSATION_PATH = /^(?:\/g\/[A-Za-z0-9_-]{1,128})?\/c\/[A-Za-z0-9-]{8,128}$/;

export function isConversationPath(path: string): boolean {
  return CONVERSATION_PATH.test(path);
}

export function targetFromUrl(url: string): TargetResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (parsed.origin !== CHATGPT_ORIGIN || parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "not-chatgpt" };
  }
  if (!isConversationPath(parsed.pathname)) return { ok: false, reason: "no-conversation" };
  return { ok: true, target: { origin: CHATGPT_ORIGIN, path: parsed.pathname } };
}

export function sameTarget(a: ConversationTarget, b: ConversationTarget): boolean {
  return a.origin === b.origin && a.path === b.path;
}

/** True when the tab is on ChatGPT at all, with or without a conversation. */
export function isChatGptUrl(url: string): boolean {
  const result = targetFromUrl(url);
  return result.ok || result.reason === "no-conversation";
}

/** A short label for people. Never compared: the path is the identity. */
export function describeTarget(target: ConversationTarget): string {
  const id = target.path.slice(target.path.lastIndexOf("/") + 1);
  const short = id.length > 8 ? "…" + id.slice(-8) : id;
  return target.path.startsWith("/g/") ? "беседа " + short + " в проекте" : "беседа " + short;
}
