import { canonicalTelegramPublicChatLink, telegramStickerPackReference } from "./public-chat-reference.ts";
import { webLink } from "./message-links.ts";
import { customEmojiId, maxMiniAppDeviceStorageBytes, miniAppChatType, type MiniAppChatType } from "./contract.ts";

export const miniAppTheme = {
  bg_color: "#101827", secondary_bg_color: "#090e18", text_color: "#edf3ff",
  hint_color: "#a6b6cc", link_color: "#81c6ff", button_color: "#19568b", button_text_color: "#edf3ff",
  header_bg_color: "#101827", bottom_bar_bg_color: "#101827", accent_text_color: "#81c6ff",
  section_bg_color: "#17263d", section_header_text_color: "#edf3ff",
  section_separator_color: "#253042", subtitle_text_color: "#a6b6cc", destructive_text_color: "#ffa6a6",
};

export function miniAppLinkReference(value: string) {
  if (value.length > 1024 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return;
  if (/^tg:\/\/resolve\?/i.test(value)) {
    const native = new URL(value);
    if (native.hash) return;
    const keys = new Set(["domain", "appname", "startapp", "mode"]);
    for (const key of native.searchParams.keys()) if (!keys.delete(key)) return;
    const bot = native.searchParams.get("domain");
    const app = native.searchParams.get("appname");
    const validName = /^[a-z][a-z0-9_]{0,63}$/i;
    if (!bot || !validName.test(bot) || (app !== null && !validName.test(app))) return;
    const url = new URL(`https://t.me/${bot}${app ? `/${app}` : ""}`);
    for (const key of ["startapp", "mode"]) {
      const parameter = native.searchParams.get(key);
      if (parameter !== null) url.searchParams.set(key, parameter);
    }
    return miniAppLinkReference(url.href);
  }
  const url = webLink(/^t\.me\//i.test(value) ? `https://${value}` : value);
  if (!url || url.origin !== "https://t.me" || url.hash) return;
  const parts = /^\/([a-z][a-z0-9_]{0,63})(?:\/([a-z][a-z0-9_]{0,63}))?\/?$/i.exec(url.pathname);
  if (!parts) return;
  const [, bot, app] = parts;
  if (!bot || !canonicalTelegramPublicChatLink(`@${bot}`) || (!app && !url.searchParams.has("startapp"))) return;
  const allowed = new Set(["startapp", "mode"]);
  for (const [key, parameter] of url.searchParams.entries()) {
    if (!allowed.delete(key)) return;
    if (key === "startapp" && !/^[A-Za-z0-9_-]{0,512}$/.test(parameter)) return;
    if (key === "mode" && parameter !== "compact" && parameter !== "fullscreen") return;
  }
  return { url: url.href, bot: bot.toLowerCase(), app };
}

export function miniAppNativeLink(value: string): string | undefined {
  const app = miniAppLinkReference(value);
  if (!app) return;
  const original = new URL(app.url).searchParams;
  const params = new URLSearchParams({ domain: app.bot });
  if (app.app) params.set("appname", app.app);
  if (!app.app || original.has("startapp")) params.set("startapp", original.get("startapp") ?? "");
  const mode = original.get("mode");
  if (mode) params.set("mode", mode);
  return "tg://resolve?" + params.toString();
}

export function miniAppLinkKey(value: string): string | undefined {
  const app = miniAppLinkReference(value);
  if (!app) return;
  const query = new URL(app.url).searchParams;
  return JSON.stringify([app.bot, app.app ?? "", query.get("startapp") ?? "", query.get("mode") ?? ""]);
}

export function miniAppFrameUrl(value: string): string | undefined {
  const url = webLink(value);
  if (!url || url.protocol !== "https:" || url.port) return;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/.test(hostname)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|home|lan)$/.test(hostname)) return;
  return url.href;
}

export function attachmentMiniAppLinkReference(value: string) {
  if (value.length > 1024 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return;
  const native = /^tg:\/\/resolve\?([^#]+)$/i.exec(value);
  const web = /^(?:https?:\/\/)?t\.me\/([a-z][a-z0-9_]{0,63}|\+[1-9]\d{1,14})\/?\?([^#]+)$/i.exec(value);
  if (!native && !web) return;
  const parameters = new URLSearchParams(native?.[1] ?? web?.[2]);
  const start = parameters.get("startattach");
  const keys = [...parameters.keys()];
  const attach = parameters.get("attach");
  const choose = parameters.get("choose");
  const domain = native ? parameters.get("domain") : web?.[1];
  const phone = native ? parameters.get("phone") : domain?.startsWith("+") ? domain.slice(1) : undefined;
  if (native && domain && phone) return;
  const bot = (attach ?? domain)?.toLowerCase();
  if (!bot || !/^[a-z][a-z0-9_]{0,63}$/.test(bot) || !canonicalTelegramPublicChatLink(`@${bot}`)
    || (start !== null && !/^[A-Za-z0-9_-]{0,512}$/.test(start)) || new Set(keys).size !== keys.length) return;
  const types: MiniAppChatType[] = [];
  if (attach !== null) {
    if (keys.some((key) => key !== "startattach" && key !== "attach" && (!native || (key !== "domain" && key !== "phone")))) return;
    const number = phone?.replace(/^[+ ]/, "");
    const username = domain?.toLowerCase();
    const destination = number && /^[1-9]\d{1,14}$/.test(number) ? { kind: "phone" as const, value: number }
      : phone == null && username && /^[a-z][a-z0-9_]{0,63}$/.test(username) && canonicalTelegramPublicChatLink(`@${username}`)
        ? { kind: "username" as const, value: username } : undefined;
    if (!destination) return;
    const path = destination.kind === "phone" ? `+${destination.value}` : destination.value;
    return { bot, start: start ?? "", types, destination,
      url: `https://t.me/${path}?attach=${bot}${start === null ? "" : `&startattach=${start}`}` };
  }
  if (start === null || phone != null || keys.some((key) => key !== "startattach" && key !== "choose" && (!native || key !== "domain"))) return;
  if (choose !== null) {
    for (const item of choose.split(/[+ ]/)) {
      const type = miniAppChatType.safeParse(item);
      if (!type.success || types.includes(type.data)) return;
      types.push(type.data);
    }
  }
  return { bot, start, types, destination: undefined, url: `https://t.me/${bot}?startattach=${start}${types.length ? `&choose=${types.join("+")}` : ""}` };
}

export function miniAppDownloadRequest(value: unknown) {
  if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string"
    || !("file_name" in value) || typeof value.file_name !== "string") return;
  const fileName = value.file_name;
  if (!fileName || fileName !== fileName.trim() || /^\.{1,2}$/.test(fileName)
    || /[\p{Cc}\p{Cf}\\/:]/u.test(fileName) || new TextEncoder().encode(fileName).length > 255) return;
  const url = miniAppFrameUrl(value.url);
  if (url) return { url, fileName };
}

const largeStorageEvents = ["web_app_device_storage_save_key", "web_app_secure_storage_save_key"];

export const miniAppFrameMessageMaxLength = 6 * maxMiniAppDeviceStorageBytes + 1024;

export function miniAppFrameEvent(data: unknown): { type: string; payload: unknown } | undefined {
  if (typeof data !== "string") return;
  const large = data.length > 32 * 1024;
  if (large && (data.length > miniAppFrameMessageMaxLength
    || !largeStorageEvents.some((type) => data.includes(`"${type}"`)))) return;
  try {
    const event = JSON.parse(data);
    if (typeof event?.eventType === "string" && (!large || largeStorageEvents.includes(event.eventType))) {
      return { type: event.eventType, payload: event.eventData };
    }
  } catch { /* Ignore malformed frame messages. */ }
}

export function miniAppRequestId(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "req_id" in payload && typeof payload.req_id === "string"
    && payload.req_id.length > 0 && payload.req_id.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(payload.req_id)) return payload.req_id;
}

export function miniAppCustomRequest(payload: unknown) {
  const requestId = miniAppRequestId(payload);
  if (!requestId || !payload || typeof payload !== "object" || !("method" in payload) || typeof payload.method !== "string"
    || !payload.method.trim() || payload.method.length > 128 || /[\p{Cc}\p{Cf}]/u.test(payload.method)
    || !("params" in payload) || !payload.params || typeof payload.params !== "object" || Array.isArray(payload.params)) return;
  try {
    const parameters = JSON.stringify(payload.params);
    if (new TextEncoder().encode(parameters).length <= 32 * 1024) return { requestId, method: payload.method, parameters };
  } catch { /* Ignore parameters that cannot be serialized. */ }
}

export function miniAppReplyData(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || !("data" in value)) return;
  const data = value.data;
  if (typeof data === "string" && data.length > 0 && new TextEncoder().encode(data).byteLength <= 4096) return data;
}

export type MiniAppButton = {
  text: string;
  active: boolean;
  progress: boolean;
  position: "left" | "right" | "top" | "bottom";
  color?: string;
  textColor?: string;
  iconCustomEmojiId?: string;
  shine: boolean;
};

function hexColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value) ? value : undefined;
}

export function miniAppButton(value: unknown): MiniAppButton | undefined {
  if (!value || typeof value !== "object" || !("is_visible" in value) || value.is_visible !== true
    || !("text" in value) || typeof value.text !== "string") return;
  const text = value.text.trim();
  if (!text || text.length > 64 || /[\p{Cc}\p{Cf}]/u.test(text)) return;
  const rawPosition = "position" in value ? value.position : undefined;
  const position = rawPosition === "right" || rawPosition === "top" || rawPosition === "bottom" ? rawPosition : "left";
  return { text, active: !("is_active" in value) || value.is_active !== false,
    progress: "is_progress_visible" in value && value.is_progress_visible === true, position,
    shine: "has_shine_effect" in value && value.has_shine_effect === true,
    iconCustomEmojiId: "icon_custom_emoji_id" in value ? customEmojiId.safeParse(value.icon_custom_emoji_id).data : undefined,
    color: "color" in value ? hexColor(value.color) : undefined,
    textColor: "text_color" in value ? hexColor(value.text_color) : undefined };
}

export function miniAppButtonVisible(value: unknown) {
  return !!value && typeof value === "object" && "is_visible" in value && value.is_visible === true;
}

const miniAppImpacts = new Map([["light", 10], ["medium", 20], ["heavy", 35], ["rigid", 25], ["soft", 12]]);
const miniAppNotifications = new Map([["error", [30, 30, 35]], ["success", [12, 24, 20]], ["warning", [20, 28, 26]]]);

export function miniAppHapticPattern(value: unknown): number | number[] | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return;
  if (value.type === "selection_change") return 8;
  if (value.type === "impact" && "impact_style" in value && typeof value.impact_style === "string") {
    return miniAppImpacts.get(value.impact_style);
  }
  if (value.type === "notification" && "notification_type" in value && typeof value.notification_type === "string") {
    return miniAppNotifications.get(value.notification_type);
  }
}

export function miniAppRequestedLink(type: string, payload: unknown): {
  url: string; telegram: boolean; instantView?: true; refreshStickerPack?: true;
} | undefined {
  if (!payload || typeof payload !== "object") return;
  if (type === "web_app_open_link" && "url" in payload && typeof payload.url === "string") {
    const target = webLink(payload.url);
    if (target) return { url: target.href, telegram: false,
      ...("try_instant_view" in payload && payload.try_instant_view === true && { instantView: true }),
    };
  }
  if (type !== "web_app_open_tg_link" || !("path_full" in payload) || typeof payload.path_full !== "string"
    || !/^\/(?![\/\\])/.test(payload.path_full) || /[\s\\]/u.test(payload.path_full)) return;
  const target = webLink(`https://t.me${payload.path_full}`);
  if (target?.origin === "https://t.me" && target.pathname !== "/") return {
    url: target.href, telegram: true,
    ...("force_request" in payload && payload.force_request === true && telegramStickerPackReference(target.href)
      && { refreshStickerPack: true }),
  };
}

export function miniAppInlineQuery(payload: unknown): { query: string; types: MiniAppChatType[] } | undefined {
  if (!payload || typeof payload !== "object" || !("query" in payload) || typeof payload.query !== "string"
    || payload.query.length > 256 || /[\p{Cc}\p{Cf}]/u.test(payload.query)) return;
  const source = "chat_types" in payload ? payload.chat_types : [];
  if (!Array.isArray(source) || source.length > 4) return;
  const types: MiniAppChatType[] = [];
  for (const value of source) {
    const type = miniAppChatType.safeParse(value);
    if (!type.success) return;
    if (!types.includes(type.data)) types.push(type.data);
  }
  return { query: payload.query, types };
}

export type MiniAppPopup = {
  title: string;
  message: string;
  buttons: { id: string; text: string; destructive: boolean }[];
};

export function miniAppPopup(value: unknown): MiniAppPopup | undefined {
  if (!value || typeof value !== "object" || !("message" in value) || typeof value.message !== "string"
    || !value.message.trim() || value.message.length > 256) return;
  const title = "title" in value ? value.title : "";
  if (typeof title !== "string" || title.length > 64) return;
  const entries = "buttons" in value ? value.buttons : [{ type: "close" }];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 3) return;
  const buttons: MiniAppPopup["buttons"] = [];
  for (const button of entries) {
    if (!button || typeof button !== "object") return;
    const id = button.id === undefined ? "" : button.id;
    if (typeof id !== "string" || id.length > 64 || buttons.some((entry) => entry.id === id)) return;
    const type = button.type === undefined ? "default" : button.type;
    const fallback = type === "ok" ? "OK" : type === "close" ? "Close" : type === "cancel" ? "Cancel" : "";
    if (!fallback && type !== "default" && type !== "destructive") return;
    const text = (fallback || (typeof button.text === "string" ? button.text.trim() : ""));
    if (!text || text.length > 64 || /[\p{Cc}\p{Cf}]/u.test(text)) return;
    buttons.push({ id, text, destructive: type === "destructive" });
  }
  return { title, message: value.message, buttons };
}

export function miniAppColor(value: unknown, colors: Record<string, string>): string | undefined {
  if (!value || typeof value !== "object") return;
  const color = "color" in value ? hexColor(value.color) : undefined;
  if (color) return color;
  if ("color_key" in value && typeof value.color_key === "string" && Object.hasOwn(colors, value.color_key)) {
    return colors[value.color_key];
  }
}

function colorLuminance(color: string) {
  const channel = (offset: number) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function miniAppContrastColor(background: string, preferred?: string) {
  const luminance = colorLuminance(background);
  if (preferred) {
    const foreground = colorLuminance(preferred);
    const contrast = (Math.max(luminance, foreground) + 0.05) / (Math.min(luminance, foreground) + 0.05);
    if (contrast >= 4.5) return preferred;
  }
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
