// Undefined is an ordinary display-name query. Null is an unsupported link or handle.
export function publicChatReference(query?: string): string | null | undefined {
  if (!query || !/^(?:@|https?:\/\/|t\.me\/)/i.test(query)) return undefined;
  const match = /^(?:@|(?:https:\/\/)?t\.me\/)([A-Za-z0-9_]{1,64})\/?$/i.exec(query);
  return match?.[1]?.toLowerCase() ?? null;
}

export function isTelegramMessageLink(value: string): boolean {
  return /^https:\/\/t\.me\/(?:c\/[1-9]\d{0,15}|[a-z][a-z0-9_]{0,63})(?:\/[1-9]\d{0,15}){1,2}\/?$/i.test(value);
}

export function telegramStickerPackName(value: string): string | undefined {
  return /^https:\/\/t\.me\/addstickers\/([A-Za-z0-9_]{1,64})\/?$/.exec(value)?.[1];
}

export function isTelegramFolderInviteLink(value: string): boolean {
  return /^https:\/\/t\.me\/addlist\/[A-Za-z0-9_-]{1,100}\/?$/.test(value);
}

export function isTelegramInviteLink(value: string): boolean {
  return /^https:\/\/t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]{1,100}\/?$/i.test(value);
}

export function isSavedMessagesQuery(query: string): boolean {
  return /^(?:saved messages|избранное)$/iu.test(query.trim());
}
