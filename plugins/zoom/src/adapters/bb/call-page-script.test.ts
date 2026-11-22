// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_PAGE_SCRIPT, MEDIA_REPORT_SCRIPT } from "./call-page.ts";

// A stand-in for Zoom's SDK that behaves like the real one where it matters:
// on() throws until init() has resolved.
function fakeSdk(options: { joinError?: unknown } = {}) {
  const listeners: Record<string, (payload: unknown) => void> = {};
  let initialised = false;
  const client = {
    init: vi.fn(async () => {
      initialised = true;
    }),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      if (!initialised) throw new TypeError("Cannot read properties of undefined (reading 'includes')");
      listeners[event] = handler;
    }),
    join: vi.fn(async () => {
      if (options.joinError !== undefined) throw options.joinError;
    }),
    leaveMeeting: vi.fn(),
    updateVideoOptions: vi.fn(),
  };
  return { client, listeners, sdk: { createClient: () => client } };
}

function fakeMedia(outcome: "ok" | DOMException) {
  const answer = () => (outcome === "ok" ? Promise.resolve({ id: "stream" }) : Promise.reject(outcome));
  const media = { getUserMedia: vi.fn(answer), getDisplayMedia: vi.fn(answer) };
  Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
  return media;
}

function run(sdk: unknown) {
  document.body.innerHTML = '<div id="meetingSDKElement"></div>';
  const posted: unknown[] = [];
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  vi.stubGlobal("ZoomMtgEmbedded", sdk);
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  new Function(MEDIA_REPORT_SCRIPT)();
  new Function(CALL_PAGE_SCRIPT)();
  const origin = new URL(window.location.origin);
  origin.hostname = "127.0.0.1";
  const say = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin:origin.origin, source: parent as unknown as Window }));
  say({ type: "zoom-call:loaded" });
  return { posted, say };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const CALL = { signature: "sig", meetingNumber: "1111111111", passcode: null, userName: "Иван", zak: "zak" };

afterEach(() => vi.unstubAllGlobals());

describe("call page script", () => {
  it("reports ready and subscribes only after the SDK is initialised", async () => {
    const { client, sdk } = fakeSdk();
    const { posted } = run(sdk);
    await settle();
    expect(posted).toEqual([{ type: "zoom-call:ready" }]);
    expect(client.on).toHaveBeenCalledTimes(1);
  });

  it("says so when the SDK did not load", () => {
    const { posted } = run(undefined);
    expect(posted).toEqual([{ type: "zoom-call:failed", message: "Не удалось загрузить Zoom Meeting SDK" }]);
  });

  it("reports a failed start instead of staying silent", async () => {
    const { posted } = run({
      createClient: () => {
        throw new Error("boom");
      },
    });
    await settle();
    expect(posted).toEqual([{ type: "zoom-call:failed", message: "Zoom Meeting SDK не запустился: boom" }]);
  });

  it("joins with an empty password when there is none and reports the connection", async () => {
    const { client, listeners, sdk } = fakeSdk();
    const { posted, say } = run(sdk);
    await settle();
    say({ type: "zoom-call:join", call: CALL });
    await settle();
    expect(client.join).toHaveBeenCalledWith({ signature: "sig", meetingNumber: "1111111111", password: "", userName: "Иван", zak: "zak" });
    listeners["connection-change"]!({ state: "Connected" });
    listeners["connection-change"]!({ state: "Closed" });
    expect(posted.slice(1)).toEqual([{ type: "zoom-call:joined" }, { type: "zoom-call:ended" }]);
  });

  it("passes Zoom's refusal to the parent", async () => {
    const { sdk } = fakeSdk({ joinError: { type: "JOIN_MEETING_FAILED", reason: "Meeting SDK app is not published", errorCode: 4011 } });
    const { posted, say } = run(sdk);
    await settle();
    say({ type: "zoom-call:join", call: CALL });
    await settle();
    expect(posted[1]).toEqual({ type: "zoom-call:error", code: "4011", message: "Meeting SDK app is not published" });
  });

  it("ignores messages that do not come from the parent window", async () => {
    const { client, sdk } = fakeSdk();
    run(sdk);
    await settle();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "zoom-call:join", call: CALL }, source: window }));
    await settle();
    expect(client.join).not.toHaveBeenCalled();
  });
});

describe("media access reports", () => {
  const denied = new DOMException("Permission denied", "NotAllowedError");

  it.each([
    ["camera", () => navigator.mediaDevices.getUserMedia({ video: true })],
    ["camera", () => navigator.mediaDevices.getUserMedia({ video: { width: 1280 }, audio: true })],
    ["microphone", () => navigator.mediaDevices.getUserMedia({ audio: true })],
    ["screen", () => navigator.mediaDevices.getDisplayMedia({ video: true })],
  ])("tells the parent when the %s is refused and still rejects for the SDK", async (kind, request) => {
    fakeMedia(denied);
    const { posted } = run(fakeSdk().sdk);
    await settle();
    await expect(request()).rejects.toBe(denied);
    expect(posted.slice(1)).toEqual([{ type: "zoom-call:media-error", kind, name: "NotAllowedError", message: "Permission denied" }]);
  });

  it("stays quiet and passes the stream through when access is granted", async () => {
    fakeMedia("ok");
    const { posted } = run(fakeSdk().sdk);
    await settle();
    expect(await navigator.mediaDevices.getUserMedia({ video: true })).toEqual({ id: "stream" });
    expect(posted).toEqual([{ type: "zoom-call:ready" }]);
  });

  it("reports a browser with no screen capture at all", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn() }, configurable: true });
    const { posted } = run(fakeSdk().sdk);
    await settle();
    await expect((navigator.mediaDevices as MediaDevices).getDisplayMedia({ video: true })).rejects.toMatchObject({ name: "NotSupportedError" });
    expect(posted.slice(1)).toEqual([
      { type: "zoom-call:media-error", kind: "screen", name: "NotSupportedError", message: "Screen capture is not available here" },
    ]);
  });
});

describe("fitting the Zoom view to the frame", () => {
  function size(width: number, height: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  }
  const lastSize = (client: { updateVideoOptions: ReturnType<typeof vi.fn> }) =>
    client.updateVideoOptions.mock.calls.at(-1)![0].viewSizes.default;

  it("fills a wide frame by height: 16:9 video plus 92 px of Zoom's own controls", async () => {
    size(1231, 623);
    const { client, listeners, sdk } = fakeSdk();
    run(sdk);
    await settle();
    listeners["connection-change"]!({ state: "Connected" });
    expect(lastSize(client)).toEqual({ width: 944, height: 531 });
    expect(client.updateVideoOptions.mock.calls.at(-1)![0].popper).toEqual({ disableDraggable: true });
  });

  it("fills a narrow frame by width", async () => {
    size(400, 900);
    const { client, listeners, sdk } = fakeSdk();
    run(sdk);
    await settle();
    listeners["connection-change"]!({ state: "Connected" });
    expect(lastSize(client)).toEqual({ width: 396, height: 222 });
  });

  it("never goes below 320 px wide", async () => {
    size(200, 150);
    const { client, listeners, sdk } = fakeSdk();
    run(sdk);
    await settle();
    listeners["connection-change"]!({ state: "Connected" });
    expect(lastSize(client)).toEqual({ width: 320, height: 180 });
  });

  it("refits after the frame is resized, once the resizing settles", async () => {
    vi.useFakeTimers();
    try {
      size(1231, 623);
      const { client, listeners, sdk } = fakeSdk();
      run(sdk);
      await vi.advanceTimersByTimeAsync(0);
      listeners["connection-change"]!({ state: "Connected" });
      const before = client.updateVideoOptions.mock.calls.length;
      size(800, 623);
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      await vi.advanceTimersByTimeAsync(149);
      expect(client.updateVideoOptions.mock.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.updateVideoOptions.mock.calls.length).toBe(before + 1);
      expect(lastSize(client)).toEqual({ width: 796, height: 447 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resize before the call is connected", async () => {
    size(1231, 623);
    const { client, sdk } = fakeSdk();
    run(sdk);
    await settle();
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.updateVideoOptions).not.toHaveBeenCalled();
  });
});

describe("theme from the host", () => {
  it("applies known colours as CSS variables and ignores everything else", async () => {
    const { say } = run(fakeSdk().sdk);
    await settle();
    say({
      type: "zoom-call:theme",
      colors: { background: "#1e1e2e", foreground: "#cdd6f4", primary: "color-mix(in oklch, #cdd6f4 13%, #1e1e2e)", evil: "red", card: "x".repeat(201), border: 5 },
    });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--bb-background")).toBe("#1e1e2e");
    expect(style.getPropertyValue("--bb-foreground")).toBe("#cdd6f4");
    expect(style.getPropertyValue("--bb-primary")).toBe("color-mix(in oklch, #cdd6f4 13%, #1e1e2e)");
    expect(style.getPropertyValue("--bb-evil")).toBe("");
    expect(style.getPropertyValue("--bb-card")).toBe("");
    expect(style.getPropertyValue("--bb-border")).toBe("");
  });
});

describe("standalone page (opened in a browser of its own)", () => {
  function standalone(sdk: unknown, call: unknown) {
    document.body.innerHTML = '<div id="notice"></div><div id="meetingSDKElement"></div>';
    vi.stubGlobal("ZoomMtgEmbedded", sdk);
    vi.stubGlobal("__ZOOM_CALL__", call);
    Object.defineProperty(window, "parent", { value: window, configurable: true });
    new Function(MEDIA_REPORT_SCRIPT)();
    new Function(CALL_PAGE_SCRIPT)();
    return () => document.getElementById("notice")!.textContent;
  }

  it("joins the call it was served with, without waiting for a parent", async () => {
    const { client, sdk } = fakeSdk();
    standalone(sdk, CALL);
    await settle();
    await settle();
    expect(client.join).toHaveBeenCalledWith({ signature: "sig", meetingNumber: "1111111111", password: "", userName: "Иван", zak: "zak" });
  });

  it("shows Zoom's refusal on the page", async () => {
    const { sdk } = fakeSdk({ joinError: { reason: "Meeting SDK app is not published", errorCode: 4011 } });
    const notice = standalone(sdk, CALL);
    await settle();
    await settle();
    expect(notice()).toBe("Zoom отклонил вход: Meeting SDK app is not published (код 4011)");
  });

  it("says the call is over when it ends", async () => {
    const { listeners, sdk } = fakeSdk();
    const notice = standalone(sdk, CALL);
    await settle();
    await settle();
    listeners["connection-change"]!({ state: "Closed" });
    expect(notice()).toBe("Звонок завершён. Эту вкладку можно закрыть.");
  });

  it("explains a page opened without a call", async () => {
    const notice = standalone(fakeSdk().sdk, undefined);
    await settle();
    expect(notice()).toBe("Эта страница открывается из плагина Makosh Zoom в BB.");
  });
});

it("queues one leave during join and waits for the SDK to confirm Closed", async () => {
  const {sdk, client, listeners} = fakeSdk();
  const {say,posted} = run(sdk);
  await settle();
  say({type:"zoom-call:join",call:CALL});
  say({type:"zoom-call:join",call:CALL});
  say({type:"zoom-call:leave"});
  say({type:"zoom-call:leave"});
  await settle();
  expect(client.join).toHaveBeenCalledTimes(1);
  expect(client.leaveMeeting).not.toHaveBeenCalled();
  listeners["connection-change"]!({state:"Connected"});
  await settle();
  expect(client.leaveMeeting).toHaveBeenCalledTimes(1);
  expect(posted).not.toContainEqual({type:"zoom-call:ended"});
  listeners["connection-change"]!({state:"Closed"});
  expect(posted.at(-1)).toEqual({type:"zoom-call:ended"});
});
