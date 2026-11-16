// Thin SDK-facing WebSocket route: one socket per attached view, bound to a
// single session handle by a single-use attach token. All token/scrollback/
// credit logic lives in host-free modules (src/core/attach.ts,
// src/core/scrollback.ts) and the service; this file only wires the SDK's
// experimental_websocket to those callbacks.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RemoteHubService } from "./service.ts";

export interface StreamSocketDeps {
  service: RemoteHubService;
}

const WS_TOKEN_EXPIRED = 4401;

export function registerStreamSocket(bb: BbPluginApi, deps: StreamSocketDeps): void {
  bb.http.experimental_websocket("/attach", ({ url }) => {
    const token = url.searchParams.get("token") ?? "";
    const binding = deps.service.consumeAttachToken(token); // single-use, 30 s TTL
    let attached = false;

    let unsubscribe: (() => void) | null = null;
    return {
      async onOpen(socket) {
        if (binding === null) {
          socket.close(WS_TOKEN_EXPIRED, "unknown or expired attach token");
          return;
        }
        attached = true;
        // Re-attach: bounded 1 MiB scrollback snapshot before live bytes.
        const snapshot = await deps.service.sessionScrollback(binding.sessionId);
        if (snapshot.byteLength > 0) socket.send(snapshot);
        unsubscribe = deps.service.subscribeSession(binding.sessionId, (data) => {
          socket.send(data);
        });
      },
      onMessage(socket, data) {
        if (!attached || binding === null) return;
        if (typeof data === "string") {
          let msg: { type?: string; cols?: number; rows?: number; bytes?: number };
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }
          switch (msg.type) {
            case "resize":
              if (typeof msg.cols === "number" && typeof msg.rows === "number") {
                void deps.service.sessionResize(
                  { generation: binding.generation, sessionId: binding.sessionId },
                  msg.cols,
                  msg.rows,
                );
              }
              break;
            case "credit":
              if (typeof msg.bytes === "number" && msg.bytes > 0) {
                void deps.service.sessionCredit(
                  { generation: binding.generation, sessionId: binding.sessionId },
                  msg.bytes,
                );
              }
              break;
            case "detach":
              socket.close(1000, "detach");
              break;
            default:
              break;
          }
        } else {
          // Binary terminal bytes from the view to the session.
          deps.service.sessionTerminalInput(binding.sessionId, data);
        }
      },
      onClose() {
        // Closing the socket detaches the view; the session keeps running in
        // the helper (SessionManager owns it).
        attached = false;
        if (unsubscribe !== null) unsubscribe();
      },
      onError() {
        attached = false;
        if (unsubscribe !== null) unsubscribe();
      },
    };
  });
}
