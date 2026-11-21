import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.ts";
import { FakeClock, scriptedFetch, type Reply } from "./testing/fakes.ts";
import { createZoomApi } from "./zoom-api.ts";

const NOW = Date.parse("2026-11-21T09:00:00Z");

function setup(...replies: Reply[]) {
  const http = scriptedFetch(...replies);
  const tokenRequests: boolean[] = [];
  const api = createZoomApi({
    fetch: http.fetch,
    clock: new FakeClock(NOW),
    accessToken: async (options) => {
      tokenRequests.push(options?.force === true);
      return options?.force === true ? "token-fresh" : "token-1";
    },
  });
  return { api, http, tokenRequests };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("expected a DomainError");
}

const meeting = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  topic: `Meeting ${id}`,
  start_time: "2026-11-23T10:00:00Z",
  duration: 30,
  join_url: `https://us02web.zoom.us/j/${id}?pwd=pass${id}`,
  ...extra,
});

describe("listUpcoming", () => {
  it("follows next_page_token until the list ends", async () => {
    const { api, http } = setup(
      { status: 200, body: { next_page_token: "page-2", meetings: [meeting(1111111111)] } },
      { status: 200, body: { next_page_token: "", meetings: [meeting(2222222222, { start_time: undefined, duration: undefined })] } },
    );
    expect(await api.listUpcoming()).toEqual([
      {
        id: "1111111111",
        topic: "Meeting 1111111111",
        startTime: "2026-11-23T10:00:00Z",
        durationMinutes: 30,
        joinUrl: "https://us02web.zoom.us/j/1111111111?pwd=pass1111111111",
        passcode: "pass1111111111",
      },
      {
        id: "2222222222",
        topic: "Meeting 2222222222",
        startTime: null,
        durationMinutes: 0,
        joinUrl: "https://us02web.zoom.us/j/2222222222?pwd=pass2222222222",
        passcode: "pass2222222222",
      },
    ]);
    expect(http.calls.map((call) => call.url)).toEqual([
      "https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=300",
      "https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=300&next_page_token=page-2",
    ]);
    expect(http.calls[0]!.request).toEqual({ method: "GET", headers: { authorization: "Bearer token-1" } });
  });

  it("stops after 10 pages even if Zoom keeps returning a token", async () => {
    const page = { status: 200, body: { next_page_token: "more", meetings: [] } };
    const { api, http } = setup(...Array.from({ length: 12 }, () => page));
    await api.listUpcoming();
    expect(http.calls).toHaveLength(10);
  });

  it("refreshes the token once on 401 and retries", async () => {
    const { api, http, tokenRequests } = setup(
      { status: 401, body: { code: 124, message: "Invalid access token." } },
      { status: 200, body: { meetings: [] } },
    );
    expect(await api.listUpcoming()).toEqual([]);
    expect(tokenRequests).toEqual([false, true]);
    expect(http.calls[1]!.request.headers.authorization).toBe("Bearer token-fresh");
  });

  it("gives up after a second 401", async () => {
    const unauthorized = { status: 401, body: { code: 124, message: "Invalid access token." } };
    const { api, http } = setup(unauthorized, unauthorized);
    expect(await codeOf(api.listUpcoming())).toBe("auth_expired");
    expect(http.calls).toHaveLength(2);
  });

  it.each([
    [429, "rate_limited"],
    [404, "not_found"],
    [500, "zoom_error"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const { api } = setup({ status, body: { code: 1, message: "x" } });
    expect(await codeOf(api.listUpcoming())).toBe(code);
  });

  it("maps a network failure to network", async () => {
    const { api } = setup(new Error("ENOTFOUND"));
    expect(await codeOf(api.listUpcoming())).toBe("network");
  });

  it("shows Zoom's own message, cut to 200 characters", async () => {
    const { api } = setup({ status: 400, body: { code: 300, message: "m".repeat(500) } });
    const error = (await api.listUpcoming().catch((e: unknown) => e)) as DomainError;
    expect(error.message).toBe(`Zoom: ${"m".repeat(200)}`);
  });

  it("rejects a reply that is not the documented shape", async () => {
    const { api } = setup({ status: 200, body: { meetings: [{ id: "x" }] } });
    expect(await codeOf(api.listUpcoming())).toBe("zoom_error");
  });
});

describe("createMeeting", () => {
  it("schedules a meeting", async () => {
    const { api, http } = setup({ status: 201, body: meeting(3333333333, { password: "secret1", duration: 45 }) });
    const created = await api.createMeeting({
      topic: "  Планёрка  ",
      startTime: "2026-11-23T10:00:00Z",
      durationMinutes: 45,
      timeZone: "Europe/Moscow",
    });
    expect(http.calls[0]!.url).toBe("https://api.zoom.us/v2/users/me/meetings");
    expect(http.calls[0]!.request).toEqual({
      method: "POST",
      headers: { authorization: "Bearer token-1", "content-type": "application/json" },
      body: '{"topic":"Планёрка","type":2,"start_time":"2026-11-23T10:00:00Z","duration":45,"timezone":"Europe/Moscow"}',
    });
    expect(created.id).toBe("3333333333");
    expect(created.passcode).toBe("secret1");
    expect(created.durationMinutes).toBe(45);
  });

  it("starts an instant meeting when no time is given", async () => {
    const { api, http } = setup({ status: 201, body: meeting(4444444444) });
    await api.createMeeting({ topic: "Сейчас", startTime: null, durationMinutes: 30, timeZone: "UTC" });
    expect(http.calls[0]!.request.body).toBe('{"topic":"Сейчас","type":1}');
  });

  it.each([
    ["an empty topic", { topic: "   " }],
    ["a topic over 200 characters", { topic: "т".repeat(201) }],
    ["a zero duration", { durationMinutes: 0 }],
    ["a duration over 24 hours", { durationMinutes: 1441 }],
    ["a fractional duration", { durationMinutes: 30.5 }],
    ["a start in the past", { startTime: "2026-11-21T08:59:59Z" }],
    ["a start that is not a date", { startTime: "tomorrow" }],
    ["a start without a UTC offset", { startTime: "2026-11-23T10:00:00" }],
  ])("refuses %s without calling Zoom", async (_name, change) => {
    const { api, http } = setup();
    const input = { topic: "Тема", startTime: "2026-11-23T10:00:00Z", durationMinutes: 30, timeZone: "UTC", ...change };
    expect(await codeOf(api.createMeeting(input))).toBe("invalid_input");
    expect(http.calls).toHaveLength(0);
  });

  it("accepts a topic of exactly 200 characters and a start at this very moment", async () => {
    const { api, http } = setup({ status: 201, body: meeting(5555555555) });
    await api.createMeeting({ topic: "т".repeat(200), startTime: "2026-11-21T09:00:00Z", durationMinutes: 1440, timeZone: "UTC" });
    expect(http.calls).toHaveLength(1);
  });
});

describe("zak and profile", () => {
  it("reads the ZAK token", async () => {
    const { api, http } = setup({ status: 200, body: { token: "zak-value" } });
    expect(await api.zak()).toBe("zak-value");
    expect(http.calls[0]!.url).toBe("https://api.zoom.us/v2/users/me/token?type=zak");
  });

  it("prefers the display name and falls back to first and last name", async () => {
    const { api } = setup(
      { status: 200, body: { display_name: "Иван И.", first_name: "Иван", last_name: "Иванов" } },
      { status: 200, body: { first_name: "Иван", last_name: "Иванов" } },
    );
    expect(await api.profile()).toEqual({ displayName: "Иван И." });
    expect(await api.profile()).toEqual({ displayName: "Иван Иванов" });
  });
});
