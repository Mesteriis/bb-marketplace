// The graphical console of one QEMU guest: noVNC (1.6.0, MPL-2.0) drawing the RFB stream our attach socket relays.
//  - noVNC is given a WebSocket-shaped channel (vnc-channel.ts) instead of a URL, so no console address ever reaches it.
//  - The VNC password arrives as ONE text message on the attach socket, is held in this closure only until noVNC asks for it, is
//    handed to noVNC once and cleared. It is never put in a URL, localStorage, React state, an RPC result or a log.
//  - The stream cannot be resumed: this view is the console's only view for good. Unmounting it ends the view, and the owner
//    reopens the console to get a new one.
//  - Modifier keys still held when the view loses focus or the tab hides are released in the guest.
//  - Clipboard is not forwarded in either direction in this version.
import { useEffect, useRef } from "react";
import type RfbType from "@novnc/novnc/core/rfb.js";
import type { FeedEvent } from "../core/agent-feed.ts";
import { reasonText, VNC_CHANNEL_BACKLOG_BYTES, type PveConsoleInfo } from "../core/pve-console.ts";

/** The view tells the service how much it consumed in steps of this size (the service allows 4 MiB in flight). */
const ACK_EVERY_BYTES = 256 * 1024;
import type { ControlMessage } from "./control-banner.tsx";
import { VncChannel } from "./vnc-channel.ts";
import { loadNovnc } from "./novnc-loader.ts";
import { ModifierTracker } from "./vnc-modifiers.ts";
import { startWatchBeat } from "./watch-beat.ts";

/** What the owner sees about the view itself, apart from the console's own state. */
export type VncViewState = "connecting" | "authenticating" | "waiting_frame" | "ready" | "ended";

export interface VncViewProps {
  wsUrl: string;
  token: string;
  onViewState?: (state: VncViewState) => void;
  onConsole?: (event: { state: PveConsoleInfo["state"]; reason: PveConsoleInfo["reason"] }) => void;
  /** The console ended or the view was refused: a code and fixed text. */
  onEnded?: (info: { code: string; text: string }) => void;
  onControl?: (message: ControlMessage) => void;
  onAgent?: (event: FeedEvent) => void;
  /** Test seam: where noVNC comes from. */
  loadRfb?: () => Promise<typeof RfbType>;
}


export function VncView(props: VncViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let disposed = false;
    let rfb: RfbType | null = null;
    // The password lives only in this variable, from the socket's message until noVNC takes it.
    let password: string | null = null;
    let wantsCredentials = false;
    // Said once: the console's own end (a `closed` or `error` message) is the specific reason; a bare socket close is only the fallback.
    let endReported = false;
    const report = (info: { code: string; text: string }): void => {
      if (endReported) return;
      endReported = true;
      propsRef.current.onEnded?.(info);
    };
    const tracker = new ModifierTracker();

    const say = (state: VncViewState): void => propsRef.current.onViewState?.(state);
    const socket = new WebSocket(props.wsUrl + "?attach=" + encodeURIComponent(props.token));
    socket.binaryType = "arraybuffer";
    const sendControl = (message: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    let consumed = 0;
    let viewerFailed = false;
    const channel = new VncChannel(
      (bytes) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
      },
      () => {
        if (socket.readyState === WebSocket.OPEN) sendControl({ type: "detach" });
        socket.close();
      },
      {
        maxQueuedBytes: VNC_CHANNEL_BACKLOG_BYTES,
        // The viewer cannot keep up or never started: the console is closed (a stream is never thinned out).
        onOverflow: () => {
          sendControl({ type: "viewer_failed" });
          report({ code: "viewer_failed", text: reasonText("viewer_failed") });
        },
        onConsumed: (bytes) => {
          consumed += bytes;
          if (consumed >= ACK_EVERY_BYTES) {
            sendControl({ type: "ack", bytes: consumed });
            consumed = 0;
          }
        },
      },
    );

    // noVNC keeps the object it is given (`_rfbCredentials`) and reads it only while it authenticates. We hand it an object we own
    // and take the password out of it as soon as that is over, on every way out, so it does not sit in the viewer afterwards.
    let held: { password?: string } | null = null;
    const forgetPassword = (): void => {
      password = null;
      wantsCredentials = false;
      if (held !== null) delete held.password;
      held = null;
    };
    const giveCredentials = (): void => {
      if (rfb === null || password === null || !wantsCredentials) return;
      const given: { password?: string } = { password };
      password = null;
      wantsCredentials = false;
      held = given;
      rfb.sendCredentials(given);
    };

    const releaseHeld = (): void => {
      const current = rfb;
      if (current === null) return;
      tracker.releaseAll((keysym, code) => current.sendKey(keysym, code, false));
      current.blur();
    };
    const onKeyDown = (e: KeyboardEvent): void => tracker.keyDown(e.code);
    const onKeyUp = (e: KeyboardEvent): void => tracker.keyUp(e.code);
    const onHidden = (): void => {
      if (document.visibilityState === "hidden") releaseHeld();
    };
    container.addEventListener("keydown", onKeyDown, true);
    container.addEventListener("keyup", onKeyUp, true);
    container.addEventListener("focusout", releaseHeld);
    window.addEventListener("blur", releaseHeld);
    document.addEventListener("visibilitychange", onHidden);

    say("connecting");
    const load = propsRef.current.loadRfb ?? loadNovnc;
    void load()
      .then((RFB) => {
        if (disposed) return;
        rfb = new RFB(container, channel, { shared: true });
        // Scale the remote screen to the pane; the guest's own resolution is never changed from here.
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.clipViewport = false;
        rfb.focusOnClick = true;
        rfb.showDotCursor = true;
        rfb.addEventListener("credentialsrequired", () => {
          say("authenticating");
          wantsCredentials = true;
          giveCredentials();
        });
        rfb.addEventListener("connect", () => {
          forgetPassword(); // the security handshake is over
          say("ready");
          rfb?.focus({ preventScroll: true });
        });
        rfb.addEventListener("securityfailure", () => {
          forgetPassword();
          report({ code: "vnc_auth_failed", text: "Консоль отклонила пароль VNC. Отключите её и откройте заново." });
        });
        rfb.addEventListener("disconnect", () => {
          forgetPassword();
          if (!disposed) say("ended");
        });
        say("waiting_frame");
      })
      .catch(() => {
        if (disposed) return;
        viewerFailed = true; // the socket may not be open yet: it is told as soon as it is
        sendControl({ type: "viewer_failed" });
        report({ code: "viewer_unavailable", text: "Не удалось запустить графический экран." });
      });

    let stopBeat: (() => void) | null = null;
    socket.onopen = () => {
      if (disposed) return;
      if (viewerFailed) sendControl({ type: "viewer_failed" });
      stopBeat = startWatchBeat(sendControl, container);
      channel.deliverOpen();
    };
    socket.onmessage = (event) => {
      if (disposed) return;
      if (typeof event.data !== "string") {
        channel.deliver(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      let msg: { type?: string; value?: string; state?: PveConsoleInfo["state"]; reason?: unknown; code?: string; text?: string; owner?: string; expiresAt?: number | null; event?: unknown };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "password" && typeof msg.value === "string") {
        password = msg.value;
        giveCredentials();
      } else if (msg.type === "console" && msg.state !== undefined) {
        propsRef.current.onConsole?.({ state: msg.state, reason: (msg.reason as PveConsoleInfo["reason"] | undefined) ?? null });
      } else if (msg.type === "closed") {
        forgetPassword();
        report({ code: typeof msg.reason === "string" ? msg.reason : (msg.code ?? "closed"), text: msg.text ?? "Консоль завершилась." });
      } else if (msg.type === "error") {
        report({ code: msg.code ?? "error", text: msg.text ?? "Не удалось показать консоль." });
      } else if (msg.type === "control" && (msg.owner === "human" || msg.owner === "agent")) {
        propsRef.current.onControl?.({ type: "control", owner: msg.owner, expiresAt: typeof msg.expiresAt === "number" ? msg.expiresAt : null });
      } else if (msg.type === "input_blocked") {
        propsRef.current.onControl?.({ type: "input_blocked" });
      } else if (msg.type === "agent" && typeof msg.event === "object") {
        propsRef.current.onAgent?.(msg.event as FeedEvent);
      }
    };
    socket.onclose = (event) => {
      forgetPassword();
      channel.deliverClose(event.code, event.reason);
      if (disposed) return;
      say("ended");
      // A socket that closes with no message of its own is a terminal outcome too: the console is gone.
      report({ code: "websocket_error", text: "Соединение с консолью оборвалось (ошибка websocket)." });
    };
    socket.onerror = () => {
      forgetPassword();
      if (!disposed) report({ code: "websocket_error", text: "Соединение с консолью оборвалось (ошибка websocket)." });
    };

    return () => {
      disposed = true;
      forgetPassword();
      if (stopBeat !== null) stopBeat();
      container.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("keyup", onKeyUp, true);
      container.removeEventListener("focusout", releaseHeld);
      window.removeEventListener("blur", releaseHeld);
      document.removeEventListener("visibilitychange", onHidden);
      releaseHeld();
      try {
        rfb?.disconnect();
      } catch {
        // already gone
      }
      if (socket.readyState === WebSocket.OPEN) sendControl({ type: "detach" });
      socket.close();
    };
  }, [props.wsUrl, props.token]);

  return <div ref={containerRef} className="rh-vnc" data-testid="vnc-view" tabIndex={-1} />;
}
