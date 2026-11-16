// Thin SDK-facing WebSocket route: one socket per attached view, bound to a
// single session handle by a single-use attach token. Token, scrollback and
// credit-window logic live in host-free modules; this file wires the SDK's
// experimental_websocket to those callbacks.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createCreditController } from "../../core/credit.ts";
import type { SessionHandle } from "../../core/rpc.ts";
import type { RemoteHubService } from "./service.ts";

export interface StreamSocketDeps {
  service: RemoteHubService;
}

const WS_TOKEN_EXPIRED = 4401;
const WS_GENERATION_STALE = 4410;
const WS_SESSION_ENDED = 4000;

const controlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.object({
    type: z.literal("credit"),
    bytes: z.number().int().min(1).max(2_147_483_647),
  }),
  z.object({ type: z.literal("detach") }),
]);

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isClosed(socket: { readyState: number }): boolean {
  return socket.readyState !== 1;
}

export function registerStreamSocket(bb: BbPluginApi, deps: StreamSocketDeps): void {
  bb.http.experimental_websocket("/attach", ({ url }) => {
    const token = url.searchParams.get("attach") ?? "";
    const binding = deps.service.consumeAttachToken(token); // single-use, 30 s TTL
    let attached = false;
    let handle: SessionHandle | null = null;
    let unsubscribe: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let offEnd: (() => void) | null = null;
    const credit = createCreditController();

    const replyError = (socket: { send: (data: string) => void }, code: string): void => {
      try {
        socket.send(JSON.stringify({ type: "error", code }));
      } catch {
        // socket already gone
      }
    };

    const closeStale = (socket: { close: (code?: number, reason?: string) => void }): void => {
      try {
        socket.close(WS_GENERATION_STALE, "session_not_found");
      } catch {
        // socket already gone
      }
    };

    return {
      async onOpen(socket) {
        if (binding === null) {
          socket.close(WS_TOKEN_EXPIRED, "unknown or expired attach token");
          return;
        }
        handle = { generation: binding.generation, sessionId: binding.sessionId };
        attached = true;

        // Subscribe before any await (V7): a close in the await window must not
        // leave a subscription behind.
        try {
          unsubscribe = deps.service.subscribeSession(handle, (data) => {
            try {
              socket.send(data);
            } catch {
              return;
            }
            const replenish = credit.consumed(data.byteLength);
            if (replenish > 0) {
              deps.service.sessionCredit(handle!, replenish).catch(() => {});
            }
          });
          offExit = deps.service.onHelperExit(() => socket.close(WS_GENERATION_STALE, "helper exited"));
          offEnd = deps.service.subscribeSessionEnd(handle, (info) => {
            socket.send(
              JSON.stringify({
                type: "closed",
                exitCode: info.exitCode,
                signal: info.signal,
                reason: info.reason,
              }),
            );
            socket.close(WS_SESSION_ENDED, "session ended");
          });
        } catch {
          closeStale(socket);
          return;
        }

        // Initial credit grant so a fresh SSH session can actually produce
        // output; the renderer replenishes through the consumed() calls above.
        const grant = credit.attach();
        try {
          await deps.service.sessionCredit(handle, grant);
        } catch {
          closeStale(socket);
          return;
        }
        if (!attached || isClosed(socket)) return;

        // Re-attach: bounded 1 MiB scrollback snapshot before live bytes.
        const snapshot = await deps.service.sessionScrollback(handle).catch(() => null);
        if (snapshot === null || !attached || isClosed(socket)) return;
        if (snapshot.byteLength > 0) {
          try {
            socket.send(snapshot);
          } catch {
            return;
          }
          const replenish = credit.consumed(snapshot.byteLength);
          if (replenish > 0) {
            deps.service.sessionCredit(handle, replenish).catch(() => {});
          }
        }
      },
      onMessage(socket, data) {
        if (!attached || handle === null) return;
        if (typeof data === "string") {
          const parsed = safeJson(data);
          const result = parsed === null ? null : controlSchema.safeParse(parsed);
          if (result === null || !result.success) {
            replyError(socket, "bad_control");
            return;
          }
          const msg = result.data;
          switch (msg.type) {
            case "resize":
              deps.service.sessionResize(handle, msg.cols, msg.rows).catch(() => {
                replyError(socket, "session_not_found");
                closeStale(socket);
              });
              break;
            case "credit":
              deps.service.sessionCredit(handle, msg.bytes).catch(() => {
                replyError(socket, "session_not_found");
                closeStale(socket);
              });
              break;
            case "detach":
              socket.close(1000, "detach");
              break;
          }
        } else {
          deps.service.sessionTerminalInput(handle, data).catch(() => {
            replyError(socket, "session_not_found");
            closeStale(socket);
          });
        }
      },
      onClose() {
        attached = false;
        credit.detach();
        if (unsubscribe !== null) unsubscribe();
        if (offExit !== null) offExit();
        if (offEnd !== null) offEnd();
      },
      onError() {
        attached = false;
        credit.detach();
        if (unsubscribe !== null) unsubscribe();
        if (offExit !== null) offExit();
        if (offEnd !== null) offEnd();
      },
    };
  });
}
