// Host-free xterm.js terminal bound to one SSH session over the binary
// WebSocket (attach token). Binary = terminal bytes both ways; text = JSON
// control (resize/credit/detach) plus the session-end "closed" frame.
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, type MutableRefObject } from "react";
import type { SshAskpassEvent } from "../core/ssh-askpass-protocol.ts";
import type { ControlMessage } from "./control-banner.tsx";
import type { FeedEvent } from "../core/agent-feed.ts";
import { startWatchBeat } from "./watch-beat.ts";

export type SshTerminalState = "connecting" | "running" | "detached" | "closed" | "error";

export interface SshExitInfo {
  exitCode: number | null;
  signal: number | null;
  reason: string;
}

export interface SshTerminalProps {
  wsUrl: string;
  token: string;
  onStateChange?: (state: SshTerminalState, exit?: SshExitInfo) => void;
  /** Prompts of OpenSSH's askpass and what happened to a saved secret. */
  onAskpass?: (event: SshAskpassEvent) => void;
  /** Who drives the session (an agent may hold it), and that the user's input was dropped because of it. */
  onControl?: (message: ControlMessage) => void;
  /** What an agent just did on this session (a command it ran, ...), for the view to show. */
  onAgent?: (event: FeedEvent) => void;
  /** Filled with a function that sends a control message on the open socket. */
  controlRef?: MutableRefObject<((msg: unknown) => void) | null>;
}

export function SshTerminal(props: SshTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let disposed = false;
    let errored = false;
    let live = false;

    // xterm 5.5 parses colours through a canvas, so CSS var() strings fail;
    // resolve the theme tokens here and pass real colour strings.
    const computed = getComputedStyle(container);
    const bg = computed.getPropertyValue("--canvas").trim() || "#0d1117";
    const fg = computed.getPropertyValue("--ink").trim() || "#c9d1d9";
    const fontTerminal = computed.getPropertyValue("--font-terminal").trim() || "monospace";
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: fontTerminal,
      theme: { background: bg, foreground: fg },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();

    const socket = new WebSocket(props.wsUrl + "?attach=" + encodeURIComponent(props.token));
    socket.binaryType = "arraybuffer";

    const sendControl = (msg: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    };
    const sendResize = (): void => {
      fit.fit();
      sendControl({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    };

    if (props.controlRef !== undefined) props.controlRef.current = sendControl;
    props.onStateChange?.("connecting");

    let stopBeat: (() => void) | null = null;
    socket.onopen = () => {
      if (disposed) return;
      props.onStateChange?.("running");
      // This view is being looked at: tell the service, so an agent may type into the session.
      stopBeat = startWatchBeat(sendControl);
      terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(new TextEncoder().encode(data));
        }
      });
      // Initial fitted resize once the socket is up (the remote starts at the
      // ssh_open defaults until then).
      sendResize();
    };

    socket.onmessage = (event) => {
      if (disposed) return;
      if (typeof event.data === "string") {
        let msg: { owner?: string; expiresAt?: number | null; type?: string; exitCode?: number | null; signal?: number | null; reason?: string; promptId?: number; text?: string; kind?: string; code?: string };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "snapshot") {
          live = false;
        } else if (msg.type === "live") {
          live = true;
        } else if (msg.type === "closed") {
          props.onStateChange?.("closed", {
            exitCode: msg.exitCode ?? null,
            signal: msg.signal ?? null,
            reason: msg.reason ?? "exited",
          });
        } else if (msg.type === "prompt" && typeof msg.promptId === "number" && typeof msg.text === "string") {
          props.onAskpass?.({ type: "prompt", promptId: msg.promptId, text: msg.text, kind: msg.kind ?? "none" });
        } else if (msg.type === "prompt_expired" && typeof msg.promptId === "number") {
          props.onAskpass?.({ type: "prompt_expired", promptId: msg.promptId });
        } else if (msg.type === "credential_rejected") {
          props.onAskpass?.({ type: "credential_rejected" });
        } else if (msg.type === "credential_failed") {
          props.onAskpass?.({ type: "credential_failed", code: msg.code ?? "unknown" });
        } else if (msg.type === "control" && (msg.owner === "human" || msg.owner === "agent")) {
          props.onControl?.({ type: "control", owner: msg.owner, expiresAt: typeof msg.expiresAt === "number" ? msg.expiresAt : null });
        } else if (msg.type === "input_blocked") {
          props.onControl?.({ type: "input_blocked" });
        } else if (msg.type === "agent" && typeof (msg as { event?: unknown }).event === "object") {
          props.onAgent?.((msg as unknown as { event: FeedEvent }).event);
        } else if (msg.type === "error") {
          // An answer to a prompt that is already gone is not a broken session.
          if (msg.code !== "prompt_gone") props.onStateChange?.("error");
        }
        return;
      }
      const bytes = new Uint8Array(event.data);
      // Capture the live flag BEFORE write; xterm defers the callback, so the
      // queued {type:"live"} message could otherwise flip it for a large
      // snapshot's callbacks.
      const ackable = live;
      terminal.write(bytes, () => {
        if (ackable && !disposed && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ack", bytes: bytes.byteLength }));
        }
      });
    };

    socket.onclose = (event: { code: number }) => {
      if (disposed || errored) return;
      if (event.code === 4000) {
        // Session ended; the closed control frame already reported the status.
        return;
      }
      if (event.code === 4410) {
        // Helper exited / session not found: the session is gone.
        props.onStateChange?.("closed", { exitCode: null, signal: null, reason: "helper_exited" });
      } else if (event.code === 1000) {
        props.onStateChange?.("detached");
      } else {
        // Unexpected socket loss is a detach, not a session close.
        props.onStateChange?.("detached");
      }
    };

    socket.onerror = () => {
      if (disposed) return;
      errored = true;
      props.onStateChange?.("error");
    };

    const observer = new ResizeObserver(() => sendResize());
    observer.observe(container);

    return () => {
      disposed = true;
      if (stopBeat !== null) stopBeat();
      observer.disconnect();
      if (props.controlRef !== undefined && props.controlRef.current === sendControl) props.controlRef.current = null;
      if (socket.readyState === WebSocket.OPEN) sendControl({ type: "detach" });
      socket.close();
      terminal.dispose();
    };
  }, [props.wsUrl, props.token]);

  return <div ref={containerRef} className="rh-terminal" />;
}
