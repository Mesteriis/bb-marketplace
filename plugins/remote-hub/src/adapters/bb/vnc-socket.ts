// The attach socket for a graphical Proxmox console (kind `vnc`). Same route and single-use token as every session; the socket
// carries
//
//   service -> view   binary: raw RFB bytes, exactly as the console sent them
//                     text:   {type:"attached", console} | {type:"password", value} | {type:"console", state, reason} |
//                             {type:"closed", reason} | {type:"error", code} | control notices
//   view -> service   binary: raw RFB bytes (what noVNC writes)
//                     text:   {type:"detach"} | {type:"watch", visible}
//
// An RFB stream cannot be resumed: exactly one view ever attaches (see VncRelay). The VNC password comes as one `password`
// message to that view, never in a URL, an RPC result or a log.
import { z } from "zod";
import type { AgentFeed } from "../../core/agent-feed.ts";
import { reasonText } from "../../core/pve-console.ts";
import type { SessionHandle } from "../../core/rpc.ts";
import type { WatcherBook } from "../../core/watchers.ts";
import { attachControlView } from "./control-notice.ts";
import type { RemoteHubService, VncAttachment } from "./service.ts";

const WS_TOKEN_EXPIRED = 4401;
const WS_GENERATION_STALE = 4410;
const WS_SESSION_ENDED = 4000;
const WS_VIEW_REFUSED = 4409;

export interface VncSocketLike {
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

const messageSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("detach") }), z.object({ type: z.literal("watch"), visible: z.boolean() })]);

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createVncSocketHandlers(
  service: RemoteHubService,
  binding: { sessionId: number; generation: string } | null,
  attachId: string,
  watchers?: WatcherBook,
  feed?: AgentFeed,
) {
  let attachment: VncAttachment | null = null;
  let handle: SessionHandle | null = null;
  let offExit: (() => void) | null = null;
  let offEnd: (() => void) | null = null;
  let offConsole: (() => void) | null = null;
  let offFeed: (() => void) | null = null;
  let control: ReturnType<typeof attachControlView> | null = null;

  const send = (socket: VncSocketLike, data: string | Uint8Array): void => {
    try {
      socket.send(data);
    } catch {
      // renderer gone
    }
  };
  const close = (socket: VncSocketLike, code: number, reason: string): void => {
    try {
      socket.close(code, reason);
    } catch {
      // socket already gone
    }
  };
  const teardown = (): void => {
    attachment?.detach();
    attachment = null;
    offExit?.();
    offEnd?.();
    offConsole?.();
    offFeed?.();
    control?.off();
    watchers?.remove(attachId);
    offExit = offEnd = offConsole = offFeed = null;
    control = null;
  };

  return {
    onOpen(socket: VncSocketLike): void {
      if (binding === null) {
        socket.close(WS_TOKEN_EXPIRED, "unknown or expired attach token");
        return;
      }
      handle = { generation: binding.generation, sessionId: binding.sessionId };
      const record = service.sessionList().find((s) => s.generation === handle!.generation && s.sessionId === handle!.sessionId);
      if (record === undefined || record.pve === undefined) {
        close(socket, WS_GENERATION_STALE, "session_not_found");
        return;
      }
      if (record.state === "closed") {
        send(socket, JSON.stringify({ type: "closed", reason: record.reason ?? "exited", text: reasonText(record.reason ?? "exited") }));
        close(socket, WS_SESSION_ENDED, "session ended");
        return;
      }
      // What the view needs to draw its header comes first; the password and the console's first bytes follow.
      send(socket, JSON.stringify({ type: "attached", console: record.pve }));
      let attached: ReturnType<RemoteHubService["vncAttach"]>;
      try {
        attached = service.vncAttach(handle, {
          sendData: (bytes) => send(socket, bytes),
          sendPassword: (value) => send(socket, JSON.stringify({ type: "password", value })),
        });
      } catch {
        close(socket, WS_GENERATION_STALE, "session_not_found");
        return;
      }
      if (!attached.ok) {
        send(socket, JSON.stringify({ type: "error", code: attached.code, text: reasonText(attached.code) }));
        close(socket, WS_VIEW_REFUSED, attached.code);
        return;
      }
      attachment = attached.attachment;
      offExit = service.onHelperExit(() => close(socket, WS_GENERATION_STALE, "helper exited"));
      offEnd = service.subscribeSessionEnd(handle, (info) => {
        send(socket, JSON.stringify({ type: "closed", reason: info.reason, text: reasonText(info.reason) }));
        close(socket, WS_SESSION_ENDED, "session ended");
      });
      offConsole = service.subscribePveConsole(handle, (event) => send(socket, JSON.stringify({ type: "console", state: event.state, reason: event.reason })));
      control = attachControlView(service, handle, (json) => send(socket, json));
      offFeed = feed?.subscribe(`${handle.generation}.${handle.sessionId}`, (event) => send(socket, JSON.stringify({ type: "agent", event }))) ?? null;
    },
    onMessage(socket: VncSocketLike, data: string | Uint8Array): void {
      if (attachment === null || handle === null) return;
      if (typeof data !== "string") {
        attachment
          .input(data)
          .then((sent) => {
            if (sent === false) control?.blocked();
          })
          .catch(() => {
            send(socket, JSON.stringify({ type: "error", code: "session_not_found" }));
            close(socket, WS_GENERATION_STALE, "session_not_found");
          });
        return;
      }
      const parsed = safeJson(data);
      const result = parsed === null ? null : messageSchema.safeParse(parsed);
      if (result === null || !result.success) {
        send(socket, JSON.stringify({ type: "error", code: "bad_control" }));
        return;
      }
      if (result.data.type === "detach") close(socket, 1000, "detach");
      else watchers?.beat(`${handle.generation}.${handle.sessionId}`, attachId, result.data.visible);
    },
    onClose(): void {
      teardown();
    },
    onError(): void {
      teardown();
    },
  };
}
