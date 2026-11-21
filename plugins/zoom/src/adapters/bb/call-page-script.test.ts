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
  const say = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: parent as unknown as Window }));
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
