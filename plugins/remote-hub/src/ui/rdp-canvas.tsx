// The RDP canvas bound to one RDP session over the attach socket (see
// src/adapters/bb/rdp-socket.ts for the wire format).
//
// - Binary frames are update chunks: the canvas draws each with putImageData
//   (a partial band or a full refresh alike) and acks the frame id ONCE per
//   frame, after drawing, so the service sends the next update.
// - Input is sent only after desktop_ready; mouse moves are coalesced to the
//   latest position per animation frame; keys held when focus is lost are
//   released; the canvas takes keyboard focus on click and forwards (and
//   prevents the default of) every key while focused.
// - An input the engine drops as stale_geometry shows a notice and asks for a
//   fresh frame.
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { clientToFramebuffer, type FitMode } from "../core/rdp-geometry.ts";
import { HeldKeys, keyEvents, mouseButtonEvent, mouseMoveEvent, mouseWheelEvent } from "../core/rdp-input-map.ts";
import { parseUpdateChunk } from "../core/rdp-protocol.ts";
import type { RdpCertPromptInfo } from "../core/rpc.ts";
import type { RdpViewInputEvent } from "../core/rdp-view-messages.ts";

export type RdpCanvasEvent =
  | { type: "socket"; state: "connecting" | "open" | "detached" | "error" }
  | { type: "attached"; state: string; prompt: RdpCertPromptInfo | null; desktop: { frameId: number; width: number; height: number } | null }
  | { type: "state"; state: string }
  | { type: "cert_prompt"; prompt: RdpCertPromptInfo }
  | { type: "desktop"; frameId: number; width: number; height: number }
  | { type: "closed"; exitCode: number | null; signal: number | null; reason: string }
  | { type: "error"; code: string }
  | { type: "notice"; text: string };

export interface RdpCanvasHandle {
  sendCtrlAltDel(): void;
  refresh(): void;
}

export interface RdpCanvasProps {
  wsUrl: string;
  token: string;
  fit: FitMode;
  label: string;
  onEvent: (event: RdpCanvasEvent) => void;
  handleRef?: Ref<RdpCanvasHandle>;
}

export function RdpCanvas(props: RdpCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fitRef = useRef<FitMode>(props.fit);
  fitRef.current = props.fit;
  const onEventRef = useRef(props.onEvent);
  onEventRef.current = props.onEvent;
  const sendRef = useRef<{ input: (events: RdpViewInputEvent[]) => void; refresh: () => void }>({
    input: () => {},
    refresh: () => {},
  });

  useImperativeHandle(
    props.handleRef,
    () => ({
      sendCtrlAltDel: () => sendRef.current.input([{ kind: "ctrl_alt_del" }]),
      refresh: () => sendRef.current.refresh(),
    }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    let disposed = false;
    let ready = false;
    let fb = { width: 0, height: 0 };
    let lastAcked = -1;
    const held = new HeldKeys();
    let queue: RdpViewInputEvent[] = [];
    let frameRequest: number | null = null;

    const emit = (event: RdpCanvasEvent): void => {
      if (!disposed) onEventRef.current(event);
    };

    const socket = new WebSocket(props.wsUrl + "?attach=" + encodeURIComponent(props.token));
    socket.binaryType = "arraybuffer";
    const sendJson = (message: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    const flush = (): void => {
      frameRequest = null;
      if (queue.length === 0) return;
      const batch = queue.slice(0, 256);
      queue = queue.slice(256);
      sendJson({ type: "input", events: batch });
      if (queue.length > 0) schedule();
    };
    const schedule = (): void => {
      if (frameRequest === null) frameRequest = requestAnimationFrame(flush);
    };
    const flushNow = (): void => {
      if (frameRequest !== null) {
        cancelAnimationFrame(frameRequest);
        frameRequest = null;
      }
      while (queue.length > 0) flush();
    };
    /** Queue events; consecutive mouse moves collapse to the latest. Input is
     *  refused until the desktop is ready. */
    const enqueue = (events: RdpViewInputEvent[]): void => {
      if (!ready || socket.readyState !== WebSocket.OPEN) return;
      for (const event of events) {
        const last = queue[queue.length - 1];
        if (event.kind === "mouse_move" && last !== undefined && last.kind === "mouse_move") queue[queue.length - 1] = event;
        else queue.push(event);
      }
      schedule();
    };
    sendRef.current = {
      input: (events) => {
        enqueue(events);
        flushNow();
      },
      refresh: () => sendJson({ type: "refresh" }),
    };

    const setReady = (value: boolean): void => {
      ready = value;
      if (!value) {
        queue = [];
        held.releaseAll();
      }
    };

    const draw = (payload: ArrayBuffer): void => {
      const chunk = parseUpdateChunk(new Uint8Array(payload));
      if (chunk === null || context === null) return;
      if (canvas.width !== chunk.fbWidth || canvas.height !== chunk.fbHeight) {
        canvas.width = chunk.fbWidth;
        canvas.height = chunk.fbHeight;
      }
      fb = { width: chunk.fbWidth, height: chunk.fbHeight };
      // `payload` is the WebSocket's own ArrayBuffer: the pixel rows are a view of it.
      const pixels = new Uint8ClampedArray(payload, chunk.pixels.byteOffset, chunk.pixels.byteLength);
      context.putImageData(new ImageData(pixels, chunk.w, chunk.h), chunk.x, chunk.y);
      // One ack per frame, after the first chunk of it is drawn: the service
      // delivers all chunks of a frame back to back.
      if (chunk.frameId !== lastAcked) {
        lastAcked = chunk.frameId;
        sendJson({ type: "ack", frameId: chunk.frameId });
      }
    };

    emit({ type: "socket", state: "connecting" });
    socket.onopen = () => emit({ type: "socket", state: "open" });
    socket.onmessage = (event: { data: unknown }) => {
      if (disposed) return;
      if (typeof event.data !== "string") {
        draw(event.data as ArrayBuffer);
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.type) {
        case "attached": {
          const desktop = (msg.desktop as { frameId: number; width: number; height: number } | null) ?? null;
          setReady(msg.state === "desktop_ready");
          if (desktop !== null) fb = { width: desktop.width, height: desktop.height };
          emit({ type: "attached", state: String(msg.state), prompt: (msg.prompt as RdpCertPromptInfo | null) ?? null, desktop });
          break;
        }
        case "state":
          setReady(msg.state === "desktop_ready");
          emit({ type: "state", state: String(msg.state) });
          break;
        case "cert_prompt":
          emit({ type: "cert_prompt", prompt: msg.prompt as RdpCertPromptInfo });
          break;
        case "desktop":
          setReady(true);
          fb = { width: Number(msg.width), height: Number(msg.height) };
          emit({ type: "desktop", frameId: Number(msg.frameId), width: fb.width, height: fb.height });
          break;
        case "closed":
          setReady(false);
          emit({
            type: "closed",
            exitCode: (msg.exitCode as number | null) ?? null,
            signal: (msg.signal as number | null) ?? null,
            reason: String(msg.reason ?? "exited"),
          });
          break;
        case "input_rejected": {
          const rejected = (msg.rejected as Array<{ code: string }> | undefined) ?? [];
          if (rejected.some((r) => r.code === "stale_geometry")) {
            emit({ type: "notice", text: "the desktop size changed; input was dropped and the picture is being refreshed" });
            sendJson({ type: "refresh" });
          }
          break;
        }
        case "error":
          emit({ type: "error", code: String(msg.code) });
          break;
      }
    };
    socket.onclose = (event: { code: number }) => {
      if (disposed) return;
      setReady(false);
      if (event.code === 4000) return; // the closed message already reported the end
      if (event.code === 4410) emit({ type: "closed", exitCode: null, signal: null, reason: "helper_exited" });
      else if (event.code === 4401) emit({ type: "error", code: "attach_token_expired" });
      else emit({ type: "socket", state: "detached" });
    };
    socket.onerror = () => emit({ type: "socket", state: "error" });

    // --- input from the DOM ---
    const position = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      if (fb.width === 0) return null;
      return clientToFramebuffer(event.clientX, event.clientY, canvas.getBoundingClientRect(), window.devicePixelRatio || 1, fitRef.current, fb);
    };
    const onMouseMove = (event: MouseEvent): void => {
      const pos = position(event);
      if (pos !== null) enqueue([mouseMoveEvent(pos, fb)]);
    };
    const onMouseButton = (down: boolean) => (event: MouseEvent): void => {
      if (down) canvas.focus();
      const pos = position(event);
      if (pos === null) return;
      const input = mouseButtonEvent(event.button, down, pos, fb);
      if (input !== null) enqueue([mouseMoveEvent(pos, fb), input]);
      event.preventDefault();
    };
    const onWheel = (event: WheelEvent): void => {
      const pos = position(event);
      if (pos === null) return;
      const input = mouseWheelEvent(event.deltaX, event.deltaY, event.deltaMode, pos, fb);
      if (input !== null) enqueue([mouseMoveEvent(pos, fb), input]);
      event.preventDefault();
    };
    const onKey = (down: boolean) => (event: KeyboardEvent): void => {
      // Every key is the remote's while the canvas is focused.
      event.preventDefault();
      if (down) held.down(event.code);
      else held.up(event.code);
      const events = keyEvents(event, down);
      if (events.length > 0) enqueue(events);
    };
    const onBlur = (): void => {
      // Keys still held would stay stuck on the remote: release them now.
      const releases = held.releaseAll();
      if (releases.length > 0 && ready && socket.readyState === WebSocket.OPEN) {
        queue = [];
        sendJson({ type: "input", events: releases });
      }
    };
    const onContextMenu = (event: Event): void => event.preventDefault();
    const handlers: Array<[string, EventListener]> = [
      ["mousemove", onMouseMove as EventListener],
      ["mousedown", onMouseButton(true) as EventListener],
      ["mouseup", onMouseButton(false) as EventListener],
      ["wheel", onWheel as EventListener],
      ["keydown", onKey(true) as EventListener],
      ["keyup", onKey(false) as EventListener],
      ["blur", onBlur],
      ["contextmenu", onContextMenu],
    ];
    for (const [name, handler] of handlers) canvas.addEventListener(name, handler);

    return () => {
      disposed = true;
      for (const [name, handler] of handlers) canvas.removeEventListener(name, handler);
      if (frameRequest !== null) cancelAnimationFrame(frameRequest);
      if (socket.readyState === WebSocket.OPEN) {
        const releases = held.releaseAll();
        if (releases.length > 0 && ready) socket.send(JSON.stringify({ type: "input", events: releases }));
        socket.send(JSON.stringify({ type: "detach" }));
      }
      socket.close();
      sendRef.current = { input: () => {}, refresh: () => {} };
    };
  }, [props.wsUrl, props.token]);

  return (
    <canvas
      ref={canvasRef}
      className={props.fit === "fit" ? "rh-rdp-canvas rh-rdp-fit" : "rh-rdp-canvas rh-rdp-actual"}
      tabIndex={0}
      role="application"
      aria-label={props.label}
    />
  );
}
