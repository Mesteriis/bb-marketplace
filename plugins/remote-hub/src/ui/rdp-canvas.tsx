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
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { startWatchBeat } from "./watch-beat.ts";
import { clientToFramebuffer, framebufferToElement, type FitMode } from "../core/rdp-geometry.ts";
import { HeldKeys, keyEvents, mouseButtonEvent, mouseMoveEvent, mouseWheelEvent } from "../core/rdp-input-map.ts";
import { parseUpdateChunk } from "../core/rdp-protocol.ts";
import type { RdpCertPromptInfo } from "../core/rpc.ts";
import { createPasteFallback } from "./paste-fallback.ts";
import { MAX_PASTE_CHARS, isPasteShortcut, modifiersHeld, pasteAsRdpEvents } from "../core/paste.ts";
import type { RdpViewInputEvent } from "../core/rdp-view-messages.ts";

export type RdpCanvasEvent =
  | { type: "socket"; state: "connecting" | "open" | "detached" | "error" }
  | { type: "attached"; state: string; prompt: RdpCertPromptInfo | null; desktop: { frameId: number; width: number; height: number } | null }
  | { type: "state"; state: string }
  | { type: "cert_prompt"; prompt: RdpCertPromptInfo }
  | { type: "desktop"; frameId: number; width: number; height: number }
  | { type: "closed"; exitCode: number | null; signal: number | null; reason: string }
  | { type: "error"; code: string }
  | { type: "notice"; text: string }
  | { type: "control"; owner: "human" | "agent"; expiresAt: number | null }
  | { type: "input_blocked" };

export interface RdpCanvasHandle {
  sendCtrlAltDel(): void;
  refresh(): void;
}

export interface RdpCanvasProps {
  wsUrl: string;
  token: string;
  fit: FitMode;
  label: string;
  canInput?: () => boolean;
  onFullFrame?: () => void;
  onEvent: (event: RdpCanvasEvent) => void;
  handleRef?: Ref<RdpCanvasHandle>;
}

const PASTE_BATCH_MS = 20;
const PASTE_CUT_TEXT = `Вставлены только первые ${MAX_PASTE_CHARS} символов.`;
/** Left Control pressed and released. */
const CTRL_TAP: readonly RdpViewInputEvent[] = [
  { kind: "key", scancode: 0x1d, extended: false, down: true },
  { kind: "key", scancode: 0x1d, extended: false, down: false },
];

function applyFit(canvas: HTMLCanvasElement, fit: FitMode): void {
  if (fit === "actual" && canvas.width > 0) {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = canvas.width / dpr + "px";
    canvas.style.height = canvas.height / dpr + "px";
  } else {
    canvas.style.width = "";
    canvas.style.height = "";
  }
}

export function RdpCanvas(props: RdpCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fitRef = useRef<FitMode>(props.fit);
  fitRef.current = props.fit;
  const inputGuard = useRef(props.canInput);
  inputGuard.current = props.canInput;
  const fullFrameRef = useRef(props.onFullFrame);
  fullFrameRef.current = props.onFullFrame;
  const onEventRef = useRef(props.onEvent);
  onEventRef.current = props.onEvent;
  const [pointer, setPointer] = useState<{ left: number; top: number; click: string | null; at: number } | null>(null);
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

  // "1:1": one framebuffer pixel is one device pixel, so the CSS size is the
  // framebuffer size divided by the device pixel ratio; "fit" is left to the CSS.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    applyFit(canvas, props.fit);
  }, [props.fit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    let disposed = false;
    let ready = false;
    let fb = { width: 0, height: 0 };
    let lastAcked = -1;
    let bandsFrame = -1;
    let bandsDrawn = 0;
    const held = new HeldKeys();
    // Buttons pressed on the canvas and not yet released, with the last pointer position.
    const heldButtons = new Set<number>();
    let lastPos = { x: 0, y: 0 };
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
      if (inputGuard.current?.() === false) { queue = []; return; }
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
      if (!ready || socket.readyState !== WebSocket.OPEN || inputGuard.current?.() === false) return;
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

    /** Button-up events for every button still held (released outside the canvas, focus
     *  lost, session ended): the remote must not keep a button pressed. */
    const releaseButtons = (): RdpViewInputEvent[] => {
      const events: RdpViewInputEvent[] = [];
      for (const button of heldButtons) {
        const up = mouseButtonEvent(button, false, lastPos, fb);
        if (up !== null) events.push(up);
      }
      heldButtons.clear();
      return events;
    };
    const setReady = (value: boolean): void => {
      ready = value;
      if (!value) {
        queue = [];
        held.releaseAll();
        heldButtons.clear();
      }
    };

    let fullRows = 0;
    const draw = (payload: ArrayBuffer): void => {
      const chunk = parseUpdateChunk(new Uint8Array(payload));
      if (chunk === null || context === null) return;
      if (canvas.width !== chunk.fbWidth || canvas.height !== chunk.fbHeight) {
        canvas.width = chunk.fbWidth;
        canvas.height = chunk.fbHeight;
        applyFit(canvas, fitRef.current);
      }
      fb = { width: chunk.fbWidth, height: chunk.fbHeight };
      // `payload` is the WebSocket's own ArrayBuffer: the pixel rows are a view of it.
      const pixels = new Uint8ClampedArray(payload, chunk.pixels.byteOffset, chunk.pixels.byteLength);
      context.putImageData(new ImageData(pixels, chunk.w, chunk.h), chunk.x, chunk.y);
      // One ack per frame, after the LAST band of it is drawn: the helper sends
      // the next update only after the ack, so acking earlier would let it
      // overwrite the bands still to come. Every band states how many there are.
      if (chunk.frameId !== bandsFrame) {
        bandsFrame = chunk.frameId;
        bandsDrawn = 0;
        fullRows = 0;
      }
      fullRows = chunk.x === 0 && chunk.w === chunk.fbWidth && chunk.y === fullRows ? fullRows + chunk.h : -1;
      bandsDrawn += 1;
      if (bandsDrawn >= chunk.chunks && chunk.frameId !== lastAcked) {
        lastAcked = chunk.frameId;
        if (fullRows === chunk.fbHeight) fullFrameRef.current?.();
        sendJson({ type: "ack", frameId: chunk.frameId });
      }
    };

    emit({ type: "socket", state: "connecting" });
    let stopBeat: (() => void) | null = null;
    let pointerTimer: ReturnType<typeof setTimeout> | null = null;
    socket.onopen = () => {
      emit({ type: "socket", state: "open" });
      // This view is being looked at: tell the service, so an agent may act on the desktop.
      stopBeat = startWatchBeat(sendJson, canvas);
    };
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
        case "control":
          if (msg.owner === "human" || msg.owner === "agent") emit({ type: "control", owner: msg.owner, expiresAt: typeof msg.expiresAt === "number" ? msg.expiresAt : null });
          break;
        case "input_blocked":
          emit({ type: "input_blocked" });
          break;
        case "agent": {
          // What an agent just did: its pointer, drawn where it is on the desktop, fading after a few seconds.
          const ev = msg.event as { kind?: string; x?: number; y?: number; width?: number; height?: number; click?: string } | undefined;
          if (ev?.kind === "pointer" && typeof ev.x === "number" && typeof ev.y === "number" && ev.width === fb.width && ev.height === fb.height) {
            const box = canvas.getBoundingClientRect();
            const at = framebufferToElement(ev.x, ev.y, { width: box.width, height: box.height }, window.devicePixelRatio || 1, fitRef.current, fb);
            if (at !== null) {
              setPointer({ ...at, click: typeof ev.click === "string" ? ev.click : null, at: Date.now() });
              if (pointerTimer !== null) clearTimeout(pointerTimer);
      if (pasteTimer !== null) clearTimeout(pasteTimer);
      fallback.cancel();
              pointerTimer = setTimeout(() => setPointer(null), 4000);
            }
          }
          break;
        }
        case "error":
          emit({ type: "error", code: String(msg.code) });
          break;
      }
    };
    socket.onclose = (event: { code: number; reason?: string }) => {
      if (disposed) return;
      setReady(false);
      if (event.code === 4000) return; // the closed message already reported the end
      // 4410 is both "the helper exited" and "this session is not known to the
      // helper any more"; the service gives the second its own close reason text.
      if (event.code === 4410 && event.reason === "session_not_found") emit({ type: "error", code: "session_not_found" });
      else if (event.code === 4410) emit({ type: "closed", exitCode: null, signal: null, reason: "helper_exited" });
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
      if (pos === null) {
        // A release over a letterbox bar still ends the press.
        if (!down) heldButtons.delete(event.button);
        return;
      }
      lastPos = pos;
      const input = mouseButtonEvent(event.button, down, pos, fb);
      if (input !== null) {
        if (down && ready) heldButtons.add(event.button);
        else heldButtons.delete(event.button);
        enqueue([mouseMoveEvent(pos, fb), input]);
      }
      event.preventDefault();
    };
    const onWindowMouseUp = (event: MouseEvent): void => {
      // A release anywhere else in the window (the canvas handler already ran for
      // a release on it and cleared the button).
      if (!heldButtons.has(event.button)) return;
      const up = mouseButtonEvent(event.button, false, lastPos, fb);
      heldButtons.delete(event.button);
      if (up !== null && ready && socket.readyState === WebSocket.OPEN) {
        flushNow(); // keep the order: what was queued goes out before this release
        sendJson({ type: "input", events: [up] });
      }
    };
    const onWheel = (event: WheelEvent): void => {
      const pos = position(event);
      if (pos === null) return;
      const input = mouseWheelEvent(event.deltaX, event.deltaY, event.deltaMode, pos, fb);
      if (input !== null) enqueue([mouseMoveEvent(pos, fb), input]);
      event.preventDefault();
    };
    const onKey = (down: boolean) => (event: KeyboardEvent): void => {
      // The one keyboard way out: Ctrl+Alt+Shift+Escape (all four held) hands the
      // keyboard back to the page. It is never forwarded.
      if (event.ctrlKey && event.altKey && event.shiftKey && event.code === "Escape") {
        event.preventDefault();
        if (down) {
          onBlur();
          canvas.blur();
        }
        return;
      }
      // Paste: there is no clipboard channel, so Cmd+V (or Ctrl+Shift+V) TYPES the Mac's clipboard text. The V is not forwarded
      // and the default is left alone, so the browser fires its paste event with the text.
      if (isPasteShortcut(event) || (pasteArmed && event.code === "KeyV")) {
        pasteArmed = down;
        // The Command key already went out as the Windows key: another key pressed while it is held keeps its release from
        // opening the Start menu. Left Control down and up does nothing else.
        if (down && event.metaKey && !event.repeat) enqueue([...CTRL_TAP]);
        if (down && !event.repeat) fallback.shortcut();
        return;
      }
      // Every key is the remote's while the canvas is focused.
      event.preventDefault();
      if (down) held.down(event.code);
      else held.up(event.code);
      const events = keyEvents(event, down);
      if (events.length > 0) enqueue(events);
      modifiersDown = modifiersHeld(event);
      typePending();
    };
    let pasteArmed = false;
    let modifiersDown = false;
    let pending: string | null = null;
    let pasteTimer: ReturnType<typeof setTimeout> | null = null;
    /** Types the waiting text once no modifier is held (typed under Command or Control it would be shortcuts on the remote). */
    const typePending = (): void => {
      if (pending === null || modifiersDown) return;
      const { batches, truncated } = pasteAsRdpEvents(pending);
      pending = null;
      if (truncated) emit({ type: "notice", text: PASTE_CUT_TEXT });
      let i = 0;
      const step = (): void => {
        pasteTimer = null;
        if (disposed || i >= batches.length || inputGuard.current?.() === false) return;
        enqueue(batches[i++] as RdpViewInputEvent[]);
        flushNow();
        if (i < batches.length) pasteTimer = setTimeout(step, PASTE_BATCH_MS);
      };
      step();
    };
    const fallback = createPasteFallback((text) => {
      pending = text;
      typePending();
    });
    const onPaste = (event: ClipboardEvent): void => {
      fallback.eventSeen();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      if (text === "") return;
      pending = text;
      typePending();
    };
    const onBlur = (): void => {
      // Send what is still queued FIRST (a queued key-up must never be dropped),
      // then release what is still held: otherwise a key whose up was queued but
      // not sent stays pressed on the remote.
      if (ready && socket.readyState === WebSocket.OPEN) flushNow();
      const releases = [...held.releaseAll(), ...releaseButtons()];
      if (releases.length > 0 && ready && socket.readyState === WebSocket.OPEN) {
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
      ["paste", onPaste as EventListener],
      ["blur", onBlur],
      ["contextmenu", onContextMenu],
    ];
    for (const [name, handler] of handlers) canvas.addEventListener(name, handler);
    window.addEventListener("mouseup", onWindowMouseUp);

    return () => {
      disposed = true;
      if (stopBeat !== null) stopBeat();
      if (pointerTimer !== null) clearTimeout(pointerTimer);
      for (const [name, handler] of handlers) canvas.removeEventListener(name, handler);
      window.removeEventListener("mouseup", onWindowMouseUp);
      if (socket.readyState === WebSocket.OPEN) {
        if (ready) flushNow();
        const releases = [...held.releaseAll(), ...releaseButtons()];
        if (releases.length > 0 && ready) socket.send(JSON.stringify({ type: "input", events: releases }));
        socket.send(JSON.stringify({ type: "detach" }));
      }
      if (frameRequest !== null) cancelAnimationFrame(frameRequest);
      socket.close();
      sendRef.current = { input: () => {}, refresh: () => {} };
    };
  }, [props.wsUrl, props.token]);

  return (
    <div className={props.fit === "fit" ? "rh-rdp-stage rh-rdp-stage-fit" : "rh-rdp-stage"}>
      <canvas
        ref={canvasRef}
        className={props.fit === "fit" ? "rh-rdp-canvas rh-rdp-fit" : "rh-rdp-canvas rh-rdp-actual"}
        tabIndex={0}
        role="application"
        aria-label={props.label}
      />
      {pointer !== null ? (
        <div className={pointer.click !== null ? "rh-agent-pointer rh-agent-pointer-click" : "rh-agent-pointer"} data-testid="agent-pointer" style={{ left: pointer.left, top: pointer.top }}>
          <span className="rh-agent-pointer-label">агент</span>
        </div>
      ) : null}
    </div>
  );
}
