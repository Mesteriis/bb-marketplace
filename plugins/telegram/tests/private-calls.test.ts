import { expect, test, vi } from "vitest";
import { Hono } from "hono";
import { createPrivateCalls } from "../src/adapters/bb/private-calls.ts";
import { privateCallFrameRoute, registerPrivateCallFrames } from "../src/adapters/bb/private-call-frames.ts";
import type { TdObject } from "../src/adapters/bb/tdjson.ts";
import type { PrivateCallEngineEvent } from "../src/adapters/bb/private-call-engine.ts";

const protocol = {
  "@type": "callProtocol" as const, min_layer: 92, max_layer: 92,
  udp_p2p: true, udp_reflector: true, library_versions: ["13.0.0"],
};

function harness() {
  let ready = true;
  let incoming = true;
  let emit: (signal: PrivateCallEngineEvent) => void = () => {};
  const engine = {
    prepare: vi.fn(async () => protocol), connect: vi.fn(async () => {}),
    signal: vi.fn(async () => {}), mute: vi.fn(async () => {}), camera: vi.fn(async () => {}),
    cameraFrame: vi.fn(async () => {}), close: vi.fn(),
  };
  const open = vi.fn((_python, callback: typeof emit) => { emit = callback; return engine; });
  const request = vi.fn(async (query: TdObject): Promise<TdObject> => {
    switch (query["@type"]) {
      case "getChat": return { "@type": "chat", id: 41, title: "Fixture chat", type: { "@type": "chatTypePrivate", user_id: 99 } };
      case "getUserFullInfo": return { "@type": "userFullInfo", can_be_called: true, supports_video_calls: true };
      case "getUser": return { "@type": "user", first_name: "Fixture caller" };
      case "createCall": return { "@type": "callId", id: 17 };
      case "acceptCall":
      case "sendCallSignalingData":
      case "discardCall": return { "@type": "ok" };
      default: throw new Error("Unexpected call request");
    }
  });
  const calls = createPrivateCalls({ python: "/fixture/python", request, isReady: () => ready, canReceive: () => incoming,
    notify: vi.fn(), open });
  function update(type: string, outgoing = true, id = 17, extra = {}, video = false) {
    calls.update({ "@type": "updateCall", call: { "@type": "call", id, user_id: 99, is_outgoing: outgoing, is_video: video,
      state: { "@type": type, ...extra } } });
  }
  return { calls, engine, open, request, update, emit: (event: Parameters<typeof emit>[0]) => emit(event),
    stop: () => { ready = false; calls.close(); }, incoming: (enabled: boolean) => { incoming = enabled; } };
}

test("starts one private voice call and relays only its media signaling", async () => {
  const { calls, engine, request, update, emit } = harness();
  const [started, occupied] = await Promise.all([calls.start(41), calls.start(41)]);
  expect([started, occupied]).toEqual([true, false]);
  expect(request).toHaveBeenCalledWith({ "@type": "createCall", user_id: 99, protocol, is_video: false });
  expect(calls.status().call).toMatchObject({ id: 17, phase: "calling" });
  calls.update({ "@type": "updateNewCallSignalingData", call_id: 18, data: "bad" });
  calls.update({ "@type": "updateNewCallSignalingData", call_id: 17, data: "YWJj" });
  update("callStateReady", true, 17, { emojis: ["A", "B", "C", "D"] });
  await vi.waitFor(() => expect(engine.signal).toHaveBeenCalledExactlyOnceWith("YWJj"));
  emit({ data: "Y2Rl" });
  expect(request).toHaveBeenCalledWith({ "@type": "sendCallSignalingData", call_id: 17, data: "Y2Rl" });
  emit({ state: "connected" });
  expect(calls.status().call).toMatchObject({ phase: "active", emojis: ["A", "B", "C", "D"] });
  await expect(calls.act(18, "mute")).resolves.toBe(false);
  await expect(calls.act(17, "mute")).resolves.toBe(true);
  expect(engine.mute).toHaveBeenCalledExactlyOnceWith(true);
  await expect(calls.act(17, "end")).resolves.toBe(true);
  expect(engine.close).toHaveBeenCalledOnce();
  expect(calls.status().call).toMatchObject({ phase: "ended" });
});

test.each([false, true])("manages both frame sources in a private video call with initial camera %s", async (camera) => {
  const { calls, engine, update, request, emit } = harness();
  const client = "camera-client";
  if (camera) {
    await expect(calls.start(41, true, client)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ "@type": "createCall", user_id: 99, protocol, is_video: true });
  } else {
    update("callStatePending", false, 17, {}, true);
    expect(calls.status().call).toMatchObject({ phase: "incoming", video: true, camera: false });
    await expect(calls.act(17, "accept")).resolves.toBe(true);
  }
  update("callStateReady", camera, 17, {}, true);
  expect(engine.connect.mock.calls[0]?.slice(1)).toEqual([camera, true, camera]);
  emit({ state: "connected" });
  await Promise.resolve();
  const ticket = calls.status().call?.frameTicket;
  expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const jpeg = Buffer.from([255, 216]);
  emit({ jpeg });
  expect(calls.frame(ticket!)?.jpeg).toEqual(jpeg);
  expect(calls.frame("wrong-ticket")).toBeUndefined();
  expect(calls.status("different-client").call?.cameraTicket).toBeUndefined();
  if (!camera) {
    expect(calls.status(client).call?.cameraTicket).toBeUndefined();
    await expect(calls.act(17, "camera-on", client)).resolves.toBe(true);
    expect(engine.camera).toHaveBeenCalledWith(true);
  }
  const upload = calls.status(client).call?.cameraTicket;
  expect(upload).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(calls.uploadCamera(ticket!, jpeg)).resolves.toBe(false);
  await expect(calls.uploadCamera(upload!, jpeg)).resolves.toBe(true);
  expect(engine.cameraFrame).toHaveBeenCalledExactlyOnceWith(jpeg);
  await expect(calls.act(17, "camera-off")).resolves.toBe(true);
  expect(engine.camera).toHaveBeenCalledWith(false);
  await expect(calls.uploadCamera(upload!, jpeg)).resolves.toBe(false);
  expect(calls.frame(ticket!)?.jpeg).toEqual(jpeg);
  await expect(calls.act(17, "end")).resolves.toBe(true);
  expect(calls.frame(ticket!)).toBeUndefined();
});

test("accepts an incoming call only on explicit action and respects the BB session preference", async () => {
  const { calls, engine, open, request, update, incoming, stop } = harness();
  incoming(false);
  update("callStatePending", false, 17);
  expect(calls.status().call).toBeNull();
  incoming(true);
  update("callStatePending", false, 18);
  expect(calls.status().call).toMatchObject({ phase: "incoming", outgoing: false });
  expect(open).not.toHaveBeenCalled();
  await expect(calls.act(17, "accept")).resolves.toBe(false);
  await expect(calls.act(18, "accept")).resolves.toBe(true);
  expect(request).toHaveBeenCalledWith({ "@type": "acceptCall", call_id: 18, protocol });
  update("callStateReady", false, 18);
  expect(engine.connect).toHaveBeenCalledOnce();
  stop();
  expect(engine.close).toHaveBeenCalledOnce();
  expect(calls.status().call).toBeNull();
});

test("sends JSON camera frames only with the current upload ticket", async () => {
  const { calls, update, emit, engine } = harness();
  await calls.start(41, true, "camera-tab");
  update("callStateReady", true, 17, {}, true);
  emit({ state: "connected" });
  await Promise.resolve();
  const status = calls.status("camera-tab").call!;
  const app = new Hono();
  registerPrivateCallFrames({ http: { route: (method, path, handler, options) => {
    expect(options).toEqual({ auth: "local" });
    app.on(method, path, handler);
  } } }, () => calls);
  const jpeg = Buffer.from([255, 216, 0, 255, 217]);
  const request = (ticket: string, payload: string, contentType = "application/json") => app.request(`${privateCallFrameRoute}?ticket=${ticket}`, {
    method: "POST", headers: { "content-type": contentType }, body: payload,
  });
  const payload = JSON.stringify({ jpeg: jpeg.toString("base64") });
  expect((await request(status.frameTicket!, payload)).status).toBe(404);
  expect((await request(status.cameraTicket!, payload, "image/jpeg")).status).toBe(400);
  expect((await request(status.cameraTicket!, payload)).status).toBe(204);
  expect(engine.cameraFrame).toHaveBeenCalledExactlyOnceWith(jpeg);
  await calls.act(17, "camera-off");
  expect((await request(status.cameraTicket!, payload)).status).toBe(404);
});
