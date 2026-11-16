// Host-free xterm.js terminal bound to one SSH session over the binary
// WebSocket (attach token). Binary = terminal bytes both ways; text = JSON
// control (resize/credit/detach).
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

export interface SshTerminalProps {
  wsUrl: string;
  token: string;
  onStateChange?: (state: "connecting" | "running" | "closed") => void;
  onClosed?: (info: { exitCode: number | null; signal: number | null; reason: string }) => void;
}

export function SshTerminal(props: SshTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "monospace",
      theme: { background: "#0d1117", foreground: "#c9d1d9" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();

    props.onStateChange?.("connecting");
    const socket = new WebSocket(props.wsUrl + "?token=" + props.token);
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      props.onStateChange?.("running");
      terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(new TextEncoder().encode(data));
        }
      });
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        // Control frame from the socket is not expected in stage 2a; ignore.
        return;
      }
      terminal.write(new Uint8Array(event.data));
    };
    socket.onclose = () => {
      props.onStateChange?.("closed");
    };
    socket.onerror = () => {
      props.onStateChange?.("closed");
    };

    const onResize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      terminal.dispose();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "detach" }));
      socket.close();
    };
  }, [props.wsUrl, props.token]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
