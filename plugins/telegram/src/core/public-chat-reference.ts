// Undefined is an ordinary display-name query. Null is an unsupported link or handle.
export function publicChatReference(query?: string): string | null | undefined {
  if (!query) return;
  const link = telegramPeerLink(query);
  if (!link && !/^(?:@|https?:\/\/|tg:|t\.me\/)/i.test(query)) return;
  const value = link ?? (query.startsWith("@") ? query : "");
  const match = /^(?:@|t\.me\/)([A-Za-z0-9_]{1,64})\/?$/i.exec(value)
    ?? /^tg:\/\/resolve\?domain=([a-z][a-z0-9_]{0,63})$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

// Telegram uses these paths for actions and web pages outside ordinary public chats.
const reservedPublicPaths = new Set([
  "addemoji", "addlist", "addstickers", "addtheme", "apps", "bg", "boost", "c", "call",
  "confirmphone", "contact", "faq", "giftcode", "invoice", "iv", "joinchat", "login",
  "m", "msg", "newbot", "privacy", "proxy", "s", "setlanguage", "share", "socks", "stars",
]);

const reservedSubdomains = new Set([
  "addstyle", "auction", "auth", "nft", "web", "www",
]);

function telegramPeerLink(value: string, limit = 256): string | undefined {
  if (value.length > limit || /[\s\p{Cc}\p{Cf}]/u.test(value)) return;
  const link = value.split("#", 1)[0]!;
  const native = /^tg:(?:\/\/)?(resolve|privatepost)\?(.+)$/i.exec(link);
  if (native) return `tg://${native[1]}?${native[2]}`;
  const web = /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/(.*)$/i.exec(link);
  if (web) return `t.me/${web[1]}`;
  const subdomain = /^(?:https?:\/\/)?([a-z][a-z0-9_]{1,63})\.t\.me(?=[/?]|$)(.*)$/i.exec(link);
  if (!subdomain) return;
  const name = subdomain[1]!.toLowerCase();
  if (reservedPublicPaths.has(name) || reservedSubdomains.has(name)) return;
  return `t.me/${name}${subdomain[2]}`;
}

export function canonicalTelegramPublicChatLink(value: string): string | undefined {
  const username = publicChatReference(value);
  if (username && !reservedPublicPaths.has(username)) return `https://t.me/${username}`;
}

export function canonicalTelegramWallpaperLink(value: string): string | undefined {
  if (value.length > 512 || /[\s\p{Cc}\p{Cf}#]/u.test(value)) return;
  const web = /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/bg\/([^/?]+)(\?.+)?$/i.exec(value);
  if (web) {
    try {
      const name = decodeURIComponent(web[1]!);
      if (/^[a-z0-9_~-]{1,128}$/i.test(name)) return `https://t.me/bg/${name}${web[2] ?? ""}`;
    } catch { return; }
    return;
  }
  const native = /^tg:(?:\/\/)?bg\?(.+)$/i.exec(value);
  if (!native) return;
  const query = new URLSearchParams(native[1]);
  const targets = [query.getAll("slug"), query.getAll("color"), query.getAll("gradient")];
  if (targets.flat().length !== 1) return;
  const [[slug], [color], [gradient]] = targets;
  if (slug && /^[a-z0-9_-]{1,128}$/i.test(slug) || color && /^[a-f0-9]{6}$/i.test(color)
    || gradient && /^(?:[a-f0-9]{6}-[a-f0-9]{6}|[a-f0-9]{6}(?:~[a-f0-9]{6}){2,3})$/i.test(gradient)) {
    return `tg://bg?${native[1]}`;
  }
}

export function telegramBusinessChatLink(value: string): string | undefined {
  if (value.length > 256 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return;
  const match = /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/m\/([A-Za-z0-9_-]{1,128})\/?$/i.exec(value)
    ?? /^tg:(?:\/\/)?message\?slug=([A-Za-z0-9_-]{1,128})$/i.exec(value);
  if (match) return `https://t.me/m/${match[1]}`;
}

export function telegramPublicChatLink(value: string): { url: string; chatUrl: string; profile: boolean; text: string } | undefined {
  const link = telegramPeerLink(value, 4096);
  if (!link) return;
  const web = /^t\.me\/([a-z][a-z0-9_]{0,63})\/?\?(.+)$/i.exec(link);
  const native = web ? null : /^tg:\/\/resolve\?(.+)$/i.exec(link);
  if (!web && !native) return;
  const rawQuery = web?.[2] ?? native?.[1] ?? "";
  try { decodeURIComponent(rawQuery); } catch { return; }
  const query = new URLSearchParams(rawQuery);
  const profile = query.has("profile");
  if ((profile && (query.getAll("profile").length !== 1 || query.get("profile") !== ""))
    || query.getAll("text").length > 1 || (native && query.getAll("domain").length !== 1)
    || [...query.keys()].some((key) => key !== "profile" && key !== "text" && !(native && key === "domain"))) return;
  const username = web?.[1] ?? query.get("domain");
  if (!username || !/^[a-z][a-z0-9_]{0,63}$/i.test(username)) return;
  const chatUrl = canonicalTelegramPublicChatLink(`@${username}`);
  const draft = (query.get("text") ?? "").trim();
  if (!chatUrl || (!profile && !draft) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft)) return;
  const text = draft.startsWith("@") ? ` ${draft}` : draft;
  const parameters = [draft ? `text=${encodeURIComponent(draft)}` : "", profile ? "profile" : ""].filter(Boolean);
  const url = `${chatUrl}?${parameters.join("&")}`;
  if (url.length <= 4096 && text.length <= 4096) return { chatUrl, url, profile, text };
}

export function telegramTemporaryContactLink(value: string): { token: string; url: string } | undefined {
  if (value.length > 256 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return;
  const link = value.split("#", 1)[0]!;
  const native = /^tg:(?:\/\/)?contact\?token=([a-z0-9_-]{1,220}={0,2})$/i.exec(link);
  const web = /^t\.me\/contact\/([a-z0-9_-]{1,220}={0,2})\/?$/i.exec(telegramPeerLink(link) ?? "");
  const token = native?.[1] ?? web?.[1];
  if (token) return { token, url: `https://t.me/contact/${token}` };
}

const messagePath = /^t\.me\/(c\/[1-9]\d{0,15}|[a-z][a-z0-9_]{0,63})(?:\/([1-9]\d{0,15}))?\/([1-9]\d{0,15})\/?(?:\?([^#]+))?$/i;
const nativeMessageLink = /^tg:\/\/(resolve|privatepost)\?([^#]+)$/i;
const positiveId = /^[1-9]\d{0,15}$/;

function mediaTimestamp(value: string): number | undefined {
  let seconds: number;
  if (/^\d+$/.test(value)) seconds = Number(value);
  else {
    const clock = /^(\d+):(\d{1,2})$/.exec(value);
    const units = /^(?:(\d+)h)?(?:(\d{1,2})m)?(?:(\d{1,2})s)?$/.exec(value);
    if (clock) seconds = Number(clock[1]) * 60 + Number(clock[2]);
    else if (units && value) seconds = Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
    else return;
  }
  if (Number.isInteger(seconds) && seconds <= 2147483647) return seconds;
}

export function decodeTelegramPollOption(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{2,256}$/.test(value)) return;
  let bytes: string;
  try {
    bytes = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes, (char) => char.charCodeAt(0)));
  } catch {
    return "";
  }
}

export function canonicalTelegramMessageLink(value: string): string | undefined {
  const link = telegramPeerLink(value);
  if (!link) return;
  const web = messagePath.exec(link);
  const native = web ? null : nativeMessageLink.exec(link);
  if (!web && !native) return;

  const privatePost = native?.[1]?.toLowerCase() === "privatepost";
  const peerKey = privatePost ? "channel" : "domain";
  const params = new URLSearchParams(web?.[4] ?? native?.[2]);
  const allowed = new Set(["thread", "comment", "single", "t", "task", "option"]);
  if (native) {
    allowed.add("post");
    allowed.add(peerKey);
  }
  for (const name of params.keys()) {
    if (!allowed.delete(name)) return;
  }

  const peer = params.get(peerKey);
  const post = web?.[3] ?? params.get("post");
  const pathThread = web?.[2];
  const queryThread = params.get("thread");
  const comment = params.get("comment");
  const single = params.get("single");
  const task = params.get("task");
  const option = params.get("option");
  const optionId = option === null ? undefined : decodeTelegramPollOption(option);
  const timestamp = params.get("t");
  const time = timestamp === null ? undefined : mediaTimestamp(timestamp);
  if (!post || !positiveId.test(post)) return;
  if (queryThread !== null && (pathThread || !positiveId.test(queryThread))) return;
  if (comment !== null && (!positiveId.test(comment) || Number(comment) > 2147483647)) return;
  if (single !== null && single !== "") return;
  if (timestamp !== null && time === undefined) return;
  if (task !== null && (!positiveId.test(task) || Number(task) > 2147483647)) return;
  if (option !== null && optionId === undefined) return;
  if (native && (!peer || (privatePost ? !positiveId.test(peer) : !/^[a-z][a-z0-9_]{0,63}$/i.test(peer)))) return;

  const chat = web?.[1]?.toLowerCase() ?? (privatePost ? `c/${peer}` : peer!.toLowerCase());
  const thread = pathThread ?? queryThread;
  const suffix = [comment ? `comment=${comment}` : "", single !== null ? "single" : "", time === undefined ? "" : `t=${time}`, task ? `task=${task}` : "", optionId ? `option=${option}` : ""].filter(Boolean).join("&");
  return `https://t.me/${chat}/${thread ? `${thread}/` : ""}${post}${suffix ? `?${suffix}` : ""}`;
}

export function isTelegramMessageLink(value: string): boolean {
  return canonicalTelegramMessageLink(value) !== undefined;
}

export function telegramGiftSlug(value: string): string | undefined {
  return (/^(?:https:\/\/)?t\.me\/nft\/([a-z0-9-]{1,128})$/i.exec(value)
    ?? /^tg:\/\/nft\?slug=([a-z0-9-]{1,128})$/i.exec(value))?.[1];
}

export function canonicalTelegramGiftLink(value: string): string | undefined {
  const slug = telegramGiftSlug(value);
  if (slug) return `https://t.me/nft/${slug}`;
}

export function canonicalTelegramBoostLink(value: string): string | undefined {
  const username = /^(?:https:\/\/)?t\.me\/(?:boost\/([a-z0-9_]{1,64})|([a-z0-9_]{1,64})\?boost)$/i.exec(value)
    ?? /^tg:\/\/boost\?domain=([a-z0-9_]{1,64})$/i.exec(value);
  if (username) return `https://t.me/boost/${(username[1] ?? username[2])!.toLowerCase()}`;
  const channel = /^(?:https:\/\/)?t\.me\/(?:boost\?c=([1-9]\d{0,15})|c\/([1-9]\d{0,15})\?boost)$/i.exec(value)
    ?? /^tg:\/\/boost\?channel=([1-9]\d{0,15})$/i.exec(value);
  if (channel) return `https://t.me/boost?c=${channel[1] ?? channel[2]}`;
}

export function parseTelegramBotStartLink(value: string): { username: string; parameter: string } | undefined {
  const direct = /^(?:https:\/\/)?t\.me\/([a-z0-9_]{1,64})\/?\?start=([a-z0-9_-]{0,64})$/i.exec(value);
  const resolve = /^tg:\/\/resolve\?domain=([a-z0-9_]{1,64})&start=([a-z0-9_-]{0,64})$/i.exec(value);
  const reversed = /^tg:\/\/resolve\?start=([a-z0-9_-]{0,64})&domain=([a-z0-9_]{1,64})$/i.exec(value);
  const username = direct?.[1] ?? resolve?.[1] ?? reversed?.[2];
  const parameter = direct?.[2] ?? resolve?.[2] ?? reversed?.[1];
  if (username && parameter !== undefined) return { username: username.toLowerCase(), parameter };
}

export function canonicalTelegramBotStartLink(value: string): string | undefined {
  const target = parseTelegramBotStartLink(value);
  return target ? `https://t.me/${target.username}?start=${target.parameter}` : undefined;
}

export function telegramGameLink(value: string) {
  const web = /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/([a-z0-9_]{1,64})\/?\?game=([a-z0-9_]{1,64})$/i.exec(value);
  const native = /^tg:\/\/resolve\?domain=([a-z0-9_]{1,64})&game=([a-z0-9_]{1,64})$/i.exec(value);
  const reversed = /^tg:\/\/resolve\?game=([a-z0-9_]{1,64})&domain=([a-z0-9_]{1,64})$/i.exec(value);
  const username = ((web ?? native)?.[1] ?? reversed?.[2])?.toLowerCase();
  const shortName = (web ?? native)?.[2] ?? reversed?.[1];
  if (username && shortName) return { username, shortName, url: `https://t.me/${username}?game=${shortName}` };
}

export function canonicalTelegramStoryAlbumLink(value: string): string | undefined {
  const web = /^(?:https:\/\/)?t\.me\/([a-z0-9_]{1,64})(?:\/a\/|\?album=)([1-9]\d{0,9})$/i.exec(value);
  const native = /^tg:\/\/resolve\?domain=([a-z0-9_]{1,64})&album=([1-9]\d{0,9})$/i.exec(value);
  const reversed = /^tg:\/\/resolve\?album=([1-9]\d{0,9})&domain=([a-z0-9_]{1,64})$/i.exec(value);
  const username = (web ?? native)?.[1] ?? reversed?.[2];
  const album = Number((web ?? native)?.[2] ?? reversed?.[1]);
  if (username && album <= 2147483647) return `https://t.me/${username.toLowerCase()}/a/${album}`;
}

export function parseTelegramStoryLink(value: string) {
  const match = /^(?:https:\/\/)?t\.me\/([a-z0-9_]{1,64})\/s\/([1-9]\d{0,9})\/?$/i.exec(value)
    ?? /^tg:\/\/resolve\?domain=([a-z0-9_]{1,64})&story=([1-9]\d{0,9})$/i.exec(value);
  const reversed = /^tg:\/\/resolve\?story=([1-9]\d{0,9})&domain=([a-z0-9_]{1,64})$/i.exec(value);
  const username = match?.[1] ?? reversed?.[2];
  const id = match?.[2] ?? reversed?.[1];
  if (!username || !id) return;
  const story = Number(id);
  if (story <= 2147483647) return { username: username.toLowerCase(), story };
}

export function canonicalTelegramStoryLink(value: string): string | undefined {
  const target = parseTelegramStoryLink(value);
  return target ? `https://t.me/${target.username}/s/${target.story}` : undefined;
}

export function telegramStickerPackReference(value: string) {
  const match = /^(?:https:\/\/)?t\.me\/(addstickers|addemoji)\/([A-Za-z0-9_]{1,64})\/?$/i.exec(value)
    ?? /^tg:\/\/(addstickers|addemoji)\?set=([A-Za-z0-9_]{1,64})$/i.exec(value);
  if (!match) return;
  const [, prefix, name] = match;
  const emoji = prefix!.toLowerCase() === "addemoji";
  return { name: name!, emoji, url: `https://t.me/${emoji ? "addemoji" : "addstickers"}/${name}` };
}

export function canonicalTelegramStickerPackLink(value: string): string | undefined {
  return telegramStickerPackReference(value)?.url;
}

export function canonicalTelegramFolderInviteLink(value: string): string | undefined {
  const slug = /^(?:https:\/\/)?t\.me\/addlist\/([A-Za-z0-9_-]{1,100})\/?$/i.exec(value)?.[1]
    ?? /^tg:\/\/addlist\?slug=([A-Za-z0-9_-]{1,100})$/i.exec(value)?.[1];
  return slug ? `https://t.me/addlist/${slug}` : undefined;
}

export function isTelegramFolderInviteLink(value: string): boolean {
  return canonicalTelegramFolderInviteLink(value) !== undefined;
}

export function canonicalTelegramInviteLink(value: string): string | undefined {
  const web = /^(?:https:\/\/)?t\.me\/(\+|joinchat\/)([A-Za-z0-9_-]{1,100})\/?$/i.exec(value);
  if (web) return `https://t.me/${web[1]!.toLowerCase()}${web[2]}`;
  const hash = /^tg:\/\/join\?invite=([A-Za-z0-9_-]{1,100})$/i.exec(value)?.[1];
  return hash ? `https://t.me/+${hash}` : undefined;
}

export function isTelegramInviteLink(value: string): boolean {
  return canonicalTelegramInviteLink(value) !== undefined;
}

export function isSavedMessagesQuery(query: string): boolean {
  return /^(?:saved messages|избранное)$/iu.test(query.trim());
}
