// The attach socket for an RDP session (stage 2b-2, C1). Same route and the same
// single-use token as SSH; for an RDP session the socket carries
//
//   service -> view   binary: one update band = 36-byte header
//                     {frameId u64, fbWidth, fbHeight, x, y, w, h, chunks u32 LE} + RGBA rows
//                     text:   {type:"attached"|"state"|"cert_prompt"|"desktop"|
//                             "input_rejected"|"closed"|"error", ...}
//   view -> service   text:   {type:"ack",frameId} | {type:"input",events} |
//                             {type:"refresh"} | {type:"detach"}
//
// There is no per-view byte queue: the view acks an update after drawing its last band and
// the service multiplexer (src/core/rdp-views.ts) sends at most one update at a
// time to it.
import type { WatcherBook } from "../../core/watchers.ts";
import type { AgentFeed } from "../../core/agent-feed.ts";
import type { SessionHandle } from "../../core/rpc.ts";
import { rdpViewMessageSchema, toHelperEvent } from "../../core/rdp-view-messages.ts";
import { attachControlView } from "./control-notice.ts";
import { HelperRequestError } from "./helper-process.ts";
import type { RdpAttachment, RemoteHubService } from "./service.ts";

const WS_TOKEN_EXPIRED = 4401;
const WS_GENERATION_STALE = 4410;
const WS_SESSION_ENDED = 4000;

export interface RdpSocketLike {
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createRdpSocketHandlers(
  service: RemoteHubService,
  binding: { sessionId: number; generation: string } | null,
  attachId: string,
  watchers?: WatcherBook,
  feed?: AgentFeed,
) {
  let attachment: RdpAttachment | null = null;
  let offExit: (() => void) | null = null;
  let offEnd: (() => void) | null = null;
  let control: ReturnType<typeof attachControlView> | null = null;
  let offFeed: (() => void) | null = null;
  let handle: SessionHandle | null = null;

  const guardSend = (socket: RdpSocketLike, data: string | Uint8Array): void => {
    try {
      socket.send(data);
    } catch {
      // renderer gone
    }
  };
  const guardClose = (socket: RdpSocketLike, code: number, reason: string): void => {
    try {
      socket.close(code, reason);
    } catch {
      // socket already gone
    }
  };
  const teardown = (): void => {
    if (attachment !== null) attachment.detach();
    attachment = null;
    if (offExit !== null) offExit();
    if (offEnd !== null) offEnd();
    if (control !== null) control.off();
    watchers?.remove(attachId);
    if (offFeed !== null) offFeed();
    offFeed = null;
    offExit = null;
    offEnd = null;
    control = null;
  };

  return {
    onOpen(socket: RdpSocketLike): void {
      if (binding === null) {
        socket.close(WS_TOKEN_EXPIRED, "unknown or expired attach token");
        return;
      }
      handle = { generation: binding.generation, sessionId: binding.sessionId };
      const record = service.sessionList().find((s) => s.generation === handle!.generation && s.sessionId === handle!.sessionId);
      if (record !== undefined && record.state === "closed") {
        guardSend(socket, JSON.stringify({ type: "closed", exitCode: record.exitCode, signal: record.signal, reason: record.reason ?? "exited" }));
        guardClose(socket, WS_SESSION_ENDED, "session ended");
        return;
      }
      try {
        attachment = service.rdpAttach(handle, attachId, {
          sendUpdate: (payload) => guardSend(socket, payload),
          sendEvent: (event) => guardSend(socket, JSON.stringify(event)),
        });
      } catch {
        guardClose(socket, WS_GENERATION_STALE, "session_not_found");
        return;
      }
      offExit = service.onHelperExit(() => guardClose(socket, WS_GENERATION_STALE, "helper exited"));
      offEnd = service.subscribeSessionEnd(handle, (info) => {
        guardSend(socket, JSON.stringify({ type: "closed", exitCode: info.exitCode, signal: info.signal, reason: info.reason }));
        guardClose(socket, WS_SESSION_ENDED, "session ended");
      });
      guardSend(socket, JSON.stringify(attachment.initial));
      control = attachControlView(service, handle, (json) => guardSend(socket, json));
      offFeed = feed?.subscribe(`${handle.generation}.${handle.sessionId}`, (event) => guardSend(socket, JSON.stringify({ type: "agent", event }))) ?? null;
    },
    onMessage(socket: RdpSocketLike, data: string | Uint8Array): void {
      if (attachment === null) return;
      if (typeof data !== "string") {
        guardSend(socket, JSON.stringify({ type: "error", code: "bad_control" }));
        return;
      }
      const parsed = safeJson(data);
      const result = parsed === null ? null : rdpViewMessageSchema.safeParse(parsed);
      if (result === null || !result.success) {
        guardSend(socket, JSON.stringify({ type: "error", code: "bad_control" }));
        return;
      }
      const msg = result.data;
      switch (msg.type) {
        case "ack":
          attachment.ack(msg.frameId);
          break;
        case "refresh":
          attachment.refresh();
          break;
        case "detach":
          guardClose(socket, 1000, "detach");
          break;
        case "watch":
          if (handle !== null) watchers?.beat(`${handle.generation}.${handle.sessionId}`, attachId, msg.visible);
          break;
        case "input":
          attachment.input(msg.events.map(toHelperEvent)).then((sent) => {
            if (sent === false) control?.blocked();
          }).catch((error: unknown) => {
            if (error instanceof HelperRequestError) {
              guardSend(socket, JSON.stringify({ type: "error", code: error.code }));
            } else {
              guardSend(socket, JSON.stringify({ type: "error", code: "session_not_found" }));
              guardClose(socket, WS_GENERATION_STALE, "session_not_found");
            }
          });
          break;
      }
    },
    onClose(): void {
      teardown();
    },
    onError(): void {
      teardown();
    },
  };
}
