import { attachmentMiniAppLinkReference, miniAppLinkReference } from "./mini-app.ts";
import { webLink } from "./message-links.ts";
import {
  canonicalTelegramBoostLink,
  canonicalTelegramBotStartLink,
  canonicalTelegramFolderInviteLink,
  canonicalTelegramGiftLink,
  canonicalTelegramInviteLink,
  canonicalTelegramMessageLink,
  canonicalTelegramPublicChatLink,
  canonicalTelegramStickerPackLink,
  canonicalTelegramStoryLink,
  canonicalTelegramStoryAlbumLink,
  canonicalTelegramWallpaperLink,
  telegramBusinessChatLink,
  telegramGameLink,
  telegramPublicChatLink,
  telegramTemporaryContactLink,
} from "./public-chat-reference.ts";

function wallpaperContentLink(value: string) {
  const link = canonicalTelegramWallpaperLink(value);
  if (!link?.startsWith("tg://")) return link;
  const query = new URL(link).searchParams;
  const name = query.get("slug") ?? query.get("color") ?? query.get("gradient");
  if (!name) return;
  for (const key of ["slug", "color", "gradient"]) query.delete(key);
  return `https://t.me/bg/${name}${query.size ? `?${query}` : ""}`;
}

export function telegramShareDraft(value: string): { url: string; text: string; link: string } | undefined {
  if (value.length > 4096 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return;
  const match = /^(?:(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:share(?:\/url)?|msg\/url)\/?|tg:(?:\/\/)?msg_url)\?([^#]+)(?:#.*)?$/i.exec(value);
  if (!match) return;
  const parameters = new URLSearchParams(match[1]);
  if ([...parameters.keys()].some((name) => name !== "url" && name !== "text")
    || parameters.getAll("url").length !== 1 || parameters.getAll("text").length > 1) return;
  const address = parameters.get("url")!.trim();
  if (/[\s\p{Cc}\p{Cf}]/u.test(address) || !webLink(address)) return;
  const text = (parameters.get("text") ?? "").trim();
  if (address.length + (text ? 1 + text.length : 0) > 4096) return;
  const link = `https://t.me/share/url?${parameters}`;
  if (link.length <= 4096) return { url: address, text, link };
}

export function canonicalTelegramManagedBotLink(value: string): string | undefined {
  if (value.length > 4096 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return;
  const web = /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/newbot\/([a-z0-9_]{1,64})(?:\/([a-z0-9_]{1,64}))?\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(value);
  const native = /^tg:(?:\/\/)?newbot\?([^#]+)(?:#.*)?$/i.exec(value);
  if (!web && !native) return;
  const params = new URLSearchParams(web ? web[3] : native?.[1]);
  const allowed = web ? ["name"] : ["manager", "username", "name"];
  if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length > 1)) return;
  const manager = web ? web[1] : params.get("manager");
  const username = web ? web[2] : params.get("username");
  const name = params.get("name");
  if (!manager || !/^[a-z0-9_]{1,64}$/i.test(manager)
    || (username && !/^[a-z0-9_]{1,64}$/i.test(username))) return;
  const query = name ? `?name=${encodeURIComponent(name)}` : "";
  const link = `https://t.me/newbot/${manager.toLowerCase()}${username ? `/${username}` : ""}${query}`;
  if (link.length <= 4096) return link;
}

export function telegramInstantViewLink(value: string): { link: string; source: string; lookup: string } | undefined {
  if (value.length > 4096 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return;
  const match = /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/iv\/?\?([^#]+)(#.*)?$/i.exec(value);
  if (!match) return;
  const params = new URLSearchParams(match[1]);
  if ([...params.keys()].some((key) => key !== "url" && key !== "rhash")
    || params.getAll("url").length !== 1 || params.getAll("rhash").length > 1) return;
  const address = params.get("url")!;
  if (/[\s\p{Cc}\p{Cf}]/u.test(address)) return;
  const original = webLink(address);
  const hash = params.get("rhash");
  if (!original || (hash && !/^[a-z0-9_-]+$/i.test(hash))) return;
  const query = new URLSearchParams({ url: address });
  if (hash) query.set("rhash", hash);
  if (match[2]) original.hash = match[2];
  const link = `https://t.me/iv?${query}${match[2] ?? ""}`;
  if (link.length <= 4096 && original.href.length <= 4096) return { link, source: original.href, lookup: hash ? link : original.href };
}

export function canonicalTelegramContentLink(value: string): string | undefined {
  return wallpaperContentLink(value) ?? canonicalTelegramMessageLink(value) ?? canonicalTelegramStickerPackLink(value)
    ?? canonicalTelegramInviteLink(value) ?? canonicalTelegramFolderInviteLink(value)
    ?? canonicalTelegramStoryAlbumLink(value) ?? canonicalTelegramStoryLink(value) ?? canonicalTelegramGiftLink(value)
    ?? canonicalTelegramBoostLink(value) ?? canonicalTelegramBotStartLink(value) ?? canonicalTelegramManagedBotLink(value)
    ?? telegramInstantViewLink(value)?.link ?? telegramShareDraft(value)?.link ?? telegramGameLink(value)?.url ?? telegramBusinessChatLink(value) ?? telegramTemporaryContactLink(value)?.url ?? miniAppLinkReference(value)?.url
    ?? attachmentMiniAppLinkReference(value)?.url
    ?? telegramPublicChatLink(value)?.url ?? canonicalTelegramPublicChatLink(value);
}

export function botButtonLink(value: string): { href: string; internal: boolean } | undefined {
  const web = webLink(value);
  if (!web && !/^tg:/i.test(value)) return;
  const internal = canonicalTelegramContentLink(value);
  if (internal && internal.length <= 4096) return { href: internal, internal: true };
  if (web) return { href: web.href, internal: false };
}
