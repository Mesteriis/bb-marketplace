import { randomBytes } from "node:crypto";
import type { PrivateCall, PrivateCallAction, PrivateCallStatus } from "../../core/contract.ts";
import { openPrivateCallEngine, type PrivateCallEngine } from "./private-call-engine.ts";
import type { TdObject } from "./tdjson.ts";

type ActiveCall = PrivateCall & {
  peer: number;
  id?: number;
  engine?: PrivateCallEngine;
  signals: string[];
  media: "idle" | "starting" | "started";
  accepted: boolean;
  busy: boolean;
  connectedAt?: number;
  frame?: { jpeg: Buffer<ArrayBuffer>; seq: number; at: number };
  cameraClient?: string;
  uploadingFrame?: boolean;
};

function record(value: unknown): TdObject | undefined {
  const entry = value as TdObject | undefined;
  return entry && typeof entry["@type"] === "string" ? entry : undefined;
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createPrivateCalls({ python, request, isReady, canReceive = () => true, notify, open = openPrivateCallEngine }: {
  python?: string;
  request: (query: TdObject, timeout?: number) => Promise<TdObject>;
  isReady: () => boolean;
  canReceive?: () => boolean;
  notify: () => void;
  open?: typeof openPrivateCallEngine;
}) {
  let current: ActiveCall | undefined;
  let closed = false;
  let checkingChat = false;
  let frameSequence = 0;
  const live = (call: ActiveCall) => current === call && !closed && isReady();

  function present(cameraClient?: string): PrivateCallStatus {
    return { available: !!python, call: current ? {
      ...(current.id && { id: current.id }), name: current.name, outgoing: current.outgoing, video: current.video,
      phase: current.phase, muted: current.muted, emojis: current.emojis, camera: current.camera,
      cameraUnavailable: current.cameraUnavailable,
      ...(current.phase === "active" && current.frameTicket && { frameTicket: current.frameTicket }),
      ...(current.phase === "active" && current.camera && current.cameraTicket && current.cameraClient === cameraClient
        && { cameraTicket: current.cameraTicket }),
    } : null };
  }

  function phase(call: ActiveCall, value: PrivateCall["phase"]) {
    if (!live(call) || call.phase === value) return;
    call.phase = value;
    notify();
  }

  function discard(call: ActiveCall, disconnected = false) {
    if (!call.id) return Promise.resolve();
    return request({ "@type": "discardCall", call_id: call.id, is_disconnected: disconnected, invite_link: "",
      duration: call.connectedAt ? Math.max(0, Math.floor((Date.now() - call.connectedAt) / 1000)) : 0,
      is_video: call.video, connection_id: "0" }, 3000).then(() => undefined);
  }

  function finish(call: ActiveCall, failed: boolean) {
    call.engine?.close();
    call.engine = undefined;
    call.signals.length = 0;
    call.frame = undefined;
    call.camera = false;
    call.cameraTicket = undefined;
    if (live(call)) phase(call, failed ? "failed" : "ended");
  }

  function failed(call: ActiveCall) {
    if (!live(call) || call.phase === "ended" || call.phase === "failed") return;
    finish(call, true);
    void discard(call, true).catch(() => {});
  }

  async function prepare(call: ActiveCall) {
    if (!python || !live(call)) throw new Error("Telegram calls are unavailable.");
    const engine = open(python, (event) => {
      if (!live(call) || call.engine !== engine || call.phase === "ending") return;
      if ("data" in event) {
        if (call.id) void request({ "@type": "sendCallSignalingData", call_id: call.id, data: event.data }).catch(() => failed(call));
      } else if ("jpeg" in event) {
        if (call.video) call.frame = { jpeg: event.jpeg, seq: ++frameSequence, at: Date.now() };
      } else if ("cameraUnavailable" in event) {
        call.camera = false;
        call.cameraUnavailable = true;
        call.cameraTicket = undefined;
        notify();
      } else if (event.state === "connected") {
        call.connectedAt ??= Date.now();
        phase(call, "active");
      } else if (["failed", "timeout", "closed"].includes(event.state)) failed(call);
    });
    call.engine = engine;
    return engine.prepare(call.peer);
  }

  function makeCall(peer: number, name: string, outgoing: boolean, video: boolean, id?: number): ActiveCall {
    return { peer, name, outgoing, video, id, phase: outgoing ? "calling" : "incoming", muted: false,
      camera: false, cameraUnavailable: false,
      ...(video && { frameTicket: randomBytes(32).toString("base64url") }),
      emojis: [], signals: [], media: "idle", accepted: outgoing, busy: false };
  }

  async function receive(event: TdObject) {
    if (!python || closed || !isReady()) return;
    if (event["@type"] === "updateNewCallSignalingData") {
      const call = current;
      const data = event.data;
      if (!call || !call.id || call.id !== event.call_id || !call.accepted || typeof data !== "string" || data.length > 64 * 1024) return;
      if (call.media === "started") void call.engine?.signal(data).catch(() => failed(call));
      else if (call.signals.length < 64) call.signals.push(data);
      return;
    }
    const raw = record(event.call);
    const status = record(raw?.state);
    if (raw?.["@type"] !== "call" || !status || !positiveId(raw.id) || !positiveId(raw.user_id)
      || typeof raw.is_outgoing !== "boolean" || typeof raw.is_video !== "boolean") return;
    const kind = status["@type"];
    let call = current;
    if (kind === "callStatePending" && !raw.is_outgoing && canReceive() && (!call || ["ended", "failed"].includes(call.phase))) {
      call = makeCall(raw.user_id, "Telegram contact", false, raw.is_video, raw.id);
      current = call;
      notify();
      const incoming = call;
      void request({ "@type": "getUser", user_id: incoming.peer }).then((user) => {
        if (!live(incoming) || user["@type"] !== "user") return;
        const name = [user.first_name, user.last_name].filter((part) => typeof part === "string").join(" ").trim().slice(0, 256);
        if (name) {
          incoming.name = name;
          notify();
        }
      }, () => {});
    }
    if (!call || call.peer !== raw.user_id || call.outgoing !== raw.is_outgoing || call.video !== raw.is_video
      || (call.id && call.id !== raw.id)) return;
    call.id = raw.id;
    if (kind === "callStateDiscarded" || kind === "callStateError") {
      if (call.phase !== "failed") finish(call, kind === "callStateError");
    } else if (!["ended", "failed", "ending"].includes(call.phase) && call.accepted) {
      if (kind === "callStateExchangingKeys") phase(call, "connecting");
      if (kind !== "callStateReady" || !call.engine || call.media !== "idle") return;
      call.media = "starting";
      call.emojis = Array.isArray(status.emojis) ? status.emojis.filter((emoji): emoji is string =>
        typeof emoji === "string" && emoji.length <= 16).slice(0, 4) : [];
      phase(call, "connecting");
      try {
        await call.engine.connect(status, call.outgoing, call.video, call.camera);
        if (!live(call) || !call.engine) return;
        call.media = "started";
        for (const data of call.signals.splice(0)) void call.engine.signal(data).catch(() => failed(call));
      } catch { failed(call); }
    }
  }

  return {
    status: present,
    frame(ticket: string) {
      const call = current;
      if (!call || !live(call) || !call.frameTicket || call.frameTicket !== ticket || call.phase !== "active") return undefined;
      const frame = call.frame;
      return frame && Date.now() - frame.at < 2000 ? frame : null;
    },
    authorizesCamera(ticket: string) {
      return !!current && live(current) && current.phase === "active" && current.camera && current.cameraTicket === ticket;
    },
    async uploadCamera(ticket: string, jpeg: Buffer) {
      const call = current;
      if (!call || !live(call) || call.cameraTicket !== ticket || !call.camera || call.phase !== "active" || !call.engine) return false;
      if (call.uploadingFrame || call.media !== "started") return true;
      call.uploadingFrame = true;
      try { await call.engine.cameraFrame(jpeg); return true; }
      catch { return false; }
      finally { call.uploadingFrame = false; }
    },
    update(event: TdObject) { void receive(event).catch(() => {}); },
    async start(chatId: number, video = false, cameraClient?: string) {
      if (!python || closed || !isReady() || checkingChat || (current && !["ended", "failed"].includes(current.phase))) return false;
      checkingChat = true;
      try {
        const chat = await request({ "@type": "getChat", chat_id: chatId });
        const peer = record(chat.type)?.user_id;
        if (chat["@type"] !== "chat" || chat.id !== chatId || record(chat.type)?.["@type"] !== "chatTypePrivate" || !positiveId(peer)) return false;
        const info = await request({ "@type": "getUserFullInfo", user_id: peer });
        if (info["@type"] !== "userFullInfo" || info.can_be_called !== true || closed || !isReady()
          || (current && !["ended", "failed"].includes(current.phase))) return false;
        const name = typeof chat.title === "string" ? chat.title.trim().slice(0, 256) : "";
        if (video && info.supports_video_calls !== true) return false;
        const call = makeCall(peer, name || "Telegram contact", true, video);
        if (video && cameraClient) {
          call.camera = true;
          call.cameraClient = cameraClient;
          call.cameraTicket = randomBytes(32).toString("base64url");
        }
        current = call;
        notify();
        try {
          const protocol = await prepare(call);
          if (!live(call) || call.phase !== "calling") return false;
          const result = await request({ "@type": "createCall", user_id: peer, protocol, is_video: video });
          if (result["@type"] !== "callId" || !positiveId(result.id)) throw new Error("Telegram rejected the call.");
          if (call.id && result.id !== call.id) throw new Error("Telegram returned a different call ID.");
          call.id = result.id;
          if (!live(call) || ["ended", "failed", "ending"].includes(call.phase)) {
            await discard(call).catch(() => {});
            return false;
          }
          notify();
          return true;
        } catch { failed(call); return false; }
      } finally { checkingChat = false; }
    },
    async act(id: number | undefined, action: PrivateCallAction, cameraClient?: string) {
      const call = current;
      if (!call || !live(call) || call.id !== id) return false;
      if (action === "dismiss" && ["ended", "failed"].includes(call.phase)) {
        current = undefined;
        notify();
        return true;
      }
      if (action === "end" && !["ended", "failed", "ending"].includes(call.phase)) {
        phase(call, "ending");
        call.engine?.close();
        call.engine = undefined;
        try { await discard(call); }
        catch { finish(call, true); return false; }
        if (call.phase === "ending") finish(call, false);
        return true;
      }
      if (call.busy || !call.id) return false;
      call.busy = true;
      try {
        if ((action === "accept" || action === "accept-video") && call.phase === "incoming") {
          if (action === "accept-video" && (!call.video || !cameraClient)) return false;
          const protocol = await prepare(call);
          if (!live(call) || call.phase !== "incoming") return false;
          call.camera = action === "accept-video";
          if (call.camera) {
            call.cameraClient = cameraClient;
            call.cameraTicket = randomBytes(32).toString("base64url");
          }
          call.accepted = true;
          phase(call, "connecting");
          const result = await request({ "@type": "acceptCall", call_id: call.id, protocol });
          if (result["@type"] !== "ok") throw new Error("Telegram rejected the call.");
          return live(call);
        }
        if ((action === "mute" || action === "unmute") && call.phase === "active" && call.engine) {
          const muted = action === "mute";
          if (muted === call.muted) return true;
          await call.engine.mute(muted);
          if (!live(call) || call.phase !== "active") return false;
          call.muted = muted;
          notify();
          return true;
        }
        if ((action === "camera-on" || action === "camera-off") && call.video && call.phase === "active" && call.engine) {
          const enabled = action === "camera-on";
          if (enabled && !cameraClient) return false;
          if (enabled === call.camera) return true;
          if (!enabled) {
            call.camera = false;
            call.cameraTicket = undefined;
            call.cameraClient = undefined;
            notify();
          }
          try { await call.engine.camera(enabled); }
          catch {
            if (!enabled) failed(call);
            return false;
          }
          if (!live(call) || call.phase !== "active") return false;
          call.camera = enabled;
          if (enabled) {
            call.cameraClient = cameraClient;
            call.cameraTicket = randomBytes(32).toString("base64url");
          }
          call.cameraUnavailable = false;
          notify();
          return true;
        }
        return false;
      } catch {
        if ((action === "accept" || action === "accept-video") && !["ending", "ended"].includes(call.phase)) failed(call);
        return false;
      } finally { call.busy = false; }
    },
    close() {
      if (closed) return;
      closed = true;
      const call = current;
      current = undefined;
      call?.engine?.close();
      if (call && !["ended", "failed", "ending"].includes(call.phase)) void discard(call).catch(() => {});
    },
  };
}
