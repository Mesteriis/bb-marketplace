// What an attached view is told about who drives its session (stage 4b-1): the owner at every change (and at attach
// when an agent already holds the session; a view assumes the human until told otherwise),
// and a notice, at most once every two seconds, when its input was dropped because an agent holds the session.
import type { SessionHandle } from "../../core/rpc.ts";
import type { RemoteHubService } from "./service.ts";

const NOTICE_EVERY_MS = 2000;

export function attachControlView(service: RemoteHubService, handle: SessionHandle, send: (json: string) => void, now: () => number = Date.now) {
  const sendOwner = (view: { owner: "human" | "agent"; expiresAt: number | null }): void => send(JSON.stringify({ type: "control", owner: view.owner, expiresAt: view.expiresAt }));
  const off = service.subscribeControl(handle, sendOwner);
  const now0 = service.controlState(handle);
  if (now0.owner !== "human") sendOwner(now0);
  let lastNotice = -Infinity;
  return {
    off,
    /** Call when input was dropped. */
    blocked(): void {
      if (now() - lastNotice < NOTICE_EVERY_MS) return;
      lastNotice = now();
      send(JSON.stringify({ type: "input_blocked" }));
    },
  };
}
