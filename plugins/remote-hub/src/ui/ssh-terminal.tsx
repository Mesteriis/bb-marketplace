// Host-free xterm.js terminal bound to one SSH session over the binary
// WebSocket (attach token). Binary = terminal bytes both ways; text = JSON
// control (resize/credit/detach) plus the session-end "closed" frame.
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

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

    props.onStateChange?.("connecting");

    socket.onopen = () => {
      if (disposed) return;
      props.onStateChange?.("running");
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
        let msg: { type?: string; exitCode?: number | null; signal?: number | null; reason?: string };
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
        } else if (msg.type === "error") {
          props.onStateChange?.("error");
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
      observer.disconnect();
      if (socket.readyState === WebSocket.OPEN) sendControl({ type: "detach" });
      socket.close();
      terminal.dispose();
    };
  }, [props.wsUrl, props.token]);

  return <div ref={containerRef} className="rh-terminal" />;
}
