import { conversationLocation, type ConversationLocation } from "../core/contract.ts";

function storageKey(scope: string) {
  return `makosh.telegram.conversation.${scope}`;
}

export function readConversationLocation(scope: string): ConversationLocation | undefined {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw || raw.length > 256) return;
    const result = conversationLocation.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    // Storage can be disabled in the current browser profile.
  }
}

export function rememberConversationLocation(scope: string, location: ConversationLocation) {
  try {
    if (conversationLocation.safeParse(location).success) localStorage.setItem(storageKey(scope), JSON.stringify(location));
  } catch {
    // The open conversation remains usable if browser storage is unavailable.
  }
}

export function forgetConversationLocation(scope: string) {
  try { localStorage.removeItem(storageKey(scope)); } catch {}
}
