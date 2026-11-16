// Thin SDK-facing WebSocket route: one socket per attached view, bound to a
// single session handle by a single-use attach token. The service owns the
// snapshot/live handoff and the per-session credit window; this file only
// wires the SDK's experimental_websocket to those callbacks.
//
// Byte ordering to the renderer: {type:"snapshot",bytes:N}, snapshot frames,
// {type:"live"}, then live frames. The renderer acks ONLY binary frames after
// {type:"live"}.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
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
    type: z.literal("ack"),
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

function isOpen(socket: { readyState: number }): boolean {
  return socket.readyState === 1;
}

export function registerStreamSocket(bb: BbPluginApi, deps: StreamSocketDeps): void {
  bb.http.experimental_websocket("/attach", ({ url }) => {
    const attachId = url.searchParams.get("attach") ?? "";
    const binding = deps.service.consumeAttachToken(attachId); // single-use, 30 s TTL
    let attached = false;
    let handle: SessionHandle | null = null;
    let unsubscribe: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let offEnd: (() => void) | null = null;

    const guardSend = (socket: { send: (data: string | Uint8Array) => void }, data: string | Uint8Array): void => {
      try {
        socket.send(data);
      } catch {
        // renderer gone
      }
    };

    const replyError = (socket: { send: (data: string | Uint8Array) => void }, code: string): void => {
      guardSend(socket, JSON.stringify({ type: "error", code }));
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

        const record = deps.service
          .sessionList()
          .find((s) => s.generation === handle!.generation && s.sessionId === handle!.sessionId);
        if (record !== undefined && record.state === "closed") {
          guardSend(
            socket,
            JSON.stringify({
              type: "closed",
              exitCode: record.exitCode,
              signal: record.signal,
              reason: record.reason ?? "exited",
            }),
          );
          socket.close(WS_SESSION_ENDED, "session ended");
          return;
        }

        attached = true;
        const grant = deps.service.creditAttach(handle!, attachId);
        let stream: { subscribe: (cb: (data: Uint8Array) => void) => () => void; cancel: () => void };
        try {
          const attachedStream = deps.service.attachStream(handle);
          guardSend(socket, JSON.stringify({ type: "snapshot", bytes: attachedStream.snapshot.byteLength }));
          if (attachedStream.snapshot.byteLength > 0) guardSend(socket, attachedStream.snapshot);
          guardSend(socket, JSON.stringify({ type: "live" }));
          stream = attachedStream;
        } catch {
          closeStale(socket);
          return;
        }
        if (grant > 0) {
          await deps.service.sessionCredit(handle!, grant).catch(() => closeStale(socket));
        }
        if (!attached || !isOpen(socket)) {
          stream.cancel();
          return;
        }
        // Output that arrived during the credit await is buffered; subscribe
        // flushes it after the live marker.
        unsubscribe = stream.subscribe((data) => {
          deps.service.creditLiveSent(handle!, attachId, data.byteLength);
          guardSend(socket, data);
        });
        offExit = deps.service.onHelperExit(() => socket.close(WS_GENERATION_STALE, "helper exited"));
        offEnd = deps.service.subscribeSessionEnd(handle!, (info) => {
          guardSend(
            socket,
            JSON.stringify({ type: "closed", exitCode: info.exitCode, signal: info.signal, reason: info.reason }),
          );
          socket.close(WS_SESSION_ENDED, "session ended");
        });
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
            case "ack": {
              const replenish = deps.service.creditAck(handle, attachId, msg.bytes);
              if (replenish > 0) {
                deps.service.sessionCredit(handle, replenish).catch(() => {
                  replyError(socket, "session_not_found");
                  closeStale(socket);
                });
              }
              break;
            }
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
        if (handle !== null) {
          const grant = deps.service.creditDetach(handle, attachId);
          if (grant > 0) deps.service.sessionCredit(handle, grant).catch(() => {});
        }
        if (unsubscribe !== null) unsubscribe();
        if (offExit !== null) offExit();
        if (offEnd !== null) offEnd();
      },
      onError() {
        attached = false;
        if (handle !== null) {
          const grant = deps.service.creditDetach(handle, attachId);
          if (grant > 0) deps.service.sessionCredit(handle, grant).catch(() => {});
        }
        if (unsubscribe !== null) unsubscribe();
        if (offExit !== null) offExit();
        if (offEnd !== null) offEnd();
      },
    };
  });
}
