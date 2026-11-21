// The few Zoom REST calls the plugin needs, all for the signed-in user
// ("me"). Replies are parsed at this boundary; the rest of the core sees
// typed values only.
import { z } from "zod";
import { DomainError } from "./errors.ts";
import type { NewMeeting, ZoomMeeting, ZoomProfile } from "./model.ts";
import type { Clock, HttpFetch, HttpRequest } from "./ports.ts";

const API = "https://api.zoom.us/v2";
const PAGE_SIZE = 300;
/** 3000 upcoming meetings is far past any real account; stops a token that never ends. */
const MAX_PAGES = 10;
const MESSAGE_LIMIT = 200;
const TOPIC_LIMIT = 200;
const MAX_DURATION_MINUTES = 24 * 60;
/** An instant with an explicit UTC offset, e.g. 2026-11-23T10:00:00Z. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const meetingSchema = z.object({
  id: z.number().int().positive(),
  topic: z.string().default(""),
  start_time: z.string().optional(),
  duration: z.number().int().nonnegative().optional(),
  join_url: z.string(),
  password: z.string().optional(),
});
const listSchema = z.object({
  next_page_token: z.string().optional(),
  meetings: z.array(meetingSchema),
});
const zakSchema = z.object({ token: z.string().min(1) });
const profileSchema = z.object({
  display_name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

export interface ZoomApiDeps {
  readonly fetch: HttpFetch;
  readonly clock: Clock;
  accessToken(options?: { force?: boolean }): Promise<string>;
}

export interface ZoomApi {
  listUpcoming(): Promise<ZoomMeeting[]>;
  createMeeting(input: NewMeeting): Promise<ZoomMeeting>;
  /** The user's ZAK: lets the Meeting SDK start or join as this user. */
  zak(): Promise<string>;
  profile(): Promise<ZoomProfile>;
}

function passcodeFromUrl(joinUrl: string): string | null {
  try {
    const value = new URL(joinUrl).searchParams.get("pwd");
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

function toMeeting(raw: z.infer<typeof meetingSchema>): ZoomMeeting {
  return {
    id: String(raw.id),
    topic: raw.topic,
    startTime: raw.start_time ?? null,
    durationMinutes: raw.duration ?? 0,
    joinUrl: raw.join_url,
    passcode: raw.password !== undefined && raw.password !== "" ? raw.password : passcodeFromUrl(raw.join_url),
  };
}

function zoomMessage(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string") {
      return (body as { message: string }).message.slice(0, MESSAGE_LIMIT);
    }
  } catch {
    // Not JSON: fall through to the status-only message.
  }
  return null;
}

export function createZoomApi(deps: ZoomApiDeps): ZoomApi {
  async function send(path: string, token: string, init: { method: "GET" | "POST"; json?: unknown }) {
    const request: HttpRequest =
      init.json === undefined
        ? { method: init.method, headers: { authorization: `Bearer ${token}` } }
        : {
            method: init.method,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(init.json),
          };
    try {
      return await deps.fetch(`${API}${path}`, request);
    } catch {
      throw new DomainError("network", "Нет связи с Zoom");
    }
  }

  async function call<T>(path: string, schema: z.ZodType<T>, init: { method: "GET" | "POST"; json?: unknown }): Promise<T> {
    let response = await send(path, await deps.accessToken(), init);
    if (response.status === 401) {
      response = await send(path, await deps.accessToken({ force: true }), init);
      if (response.status === 401) {
        throw new DomainError("auth_expired", "Zoom отклонил вход. Подключите аккаунт заново");
      }
    }
    const text = await response.text();
    if (response.status === 429) throw new DomainError("rate_limited", "Zoom ограничил частоту запросов. Повторите позже");
    if (response.status === 404) throw new DomainError("not_found", "Zoom не нашёл такую встречу");
    if (response.status < 200 || response.status >= 300) {
      const message = zoomMessage(text);
      throw new DomainError("zoom_error", message === null ? `Zoom ответил ошибкой (HTTP ${response.status})` : `Zoom: ${message}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DomainError("zoom_error", "Zoom прислал ответ, который не удалось разобрать");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new DomainError("zoom_error", "Zoom прислал ответ в неожиданном виде");
    return parsed.data;
  }

  function validate(input: NewMeeting): { topic: string } {
    const topic = input.topic.trim();
    if (topic === "" || topic.length > TOPIC_LIMIT) {
      throw new DomainError("invalid_input", `Тема: от 1 до ${TOPIC_LIMIT} символов`);
    }
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > MAX_DURATION_MINUTES) {
      throw new DomainError("invalid_input", "Длительность: от 1 минуты до 24 часов");
    }
    if (input.startTime !== null) {
      const start = UTC_INSTANT.test(input.startTime) ? Date.parse(input.startTime) : Number.NaN;
      if (Number.isNaN(start)) throw new DomainError("invalid_input", "Начало: укажите дату и время");
      if (start < deps.clock.now()) throw new DomainError("invalid_input", "Начало уже прошло");
    }
    return { topic };
  }

  return {
    async listUpcoming() {
      const meetings: ZoomMeeting[] = [];
      let pageToken = "";
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ type: "upcoming", page_size: String(PAGE_SIZE) });
        if (pageToken !== "") query.set("next_page_token", pageToken);
        const result = await call(`/users/me/meetings?${query.toString()}`, listSchema, { method: "GET" });
        meetings.push(...result.meetings.map(toMeeting));
        pageToken = result.next_page_token ?? "";
        if (pageToken === "") break;
      }
      return meetings;
    },

    async createMeeting(input) {
      const { topic } = validate(input);
      const json =
        input.startTime === null
          ? { topic, type: 1 }
          : { topic, type: 2, start_time: input.startTime, duration: input.durationMinutes, timezone: input.timeZone };
      return toMeeting(await call("/users/me/meetings", meetingSchema, { method: "POST", json }));
    },

    async zak() {
      return (await call("/users/me/token?type=zak", zakSchema, { method: "GET" })).token;
    },

    async profile() {
      const raw = await call("/users/me", profileSchema, { method: "GET" });
      const fallback = [raw.first_name, raw.last_name].filter((part) => part !== undefined && part !== "").join(" ");
      const displayName = raw.display_name !== undefined && raw.display_name !== "" ? raw.display_name : fallback;
      return { displayName: displayName === "" ? "Zoom" : displayName };
    },
  };
}
