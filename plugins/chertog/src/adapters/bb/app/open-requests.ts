// The page side of chertog.open.v1: any BB plugin may ask this window to
// open a thread or a provider panel as a tile. The request is validated, the
// session decides, and the answer is written into the request's detail
// object before dispatch returns (docs/open-wire-v1.md).
import { useEffect } from "react";
import type { PanelRef } from "../../../core/panels/index.ts";
import { isAcceptedOutcome, OPEN_EVENT, openRequestSchema, type OpenOutcome } from "../../../core/wire/index.ts";

/** What the listener needs of the workspace session. */
export interface OpenTarget {
  openThread(threadId: string): Exclude<OpenOutcome, "unsupported" | "invalid">;
  openPanel(ref: PanelRef): Exclude<OpenOutcome, "invalid">;
}

function answer(detail: Record<string, unknown>, outcome: OpenOutcome): void {
  detail.accepted = isAcceptedOutcome(outcome);
  detail.outcome = outcome;
}

/** Handles one event; never throws, and leaves anything that is not a request alone. */
export function handleOpenEvent(event: Event, target: OpenTarget): void {
  const detail: unknown = (event as CustomEvent).detail;
  if (typeof detail !== "object" || detail === null || Object.isFrozen(detail)) return;
  const reply = detail as Record<string, unknown>;
  // Another listener already took it.
  if (reply.accepted === true) return;
  const request = openRequestSchema.safeParse(detail);
  if (!request.success) return answer(reply, "invalid");
  try {
    answer(reply, request.data.kind === "thread" ? target.openThread(request.data.threadId) : target.openPanel(request.data.ref));
  } catch (error) {
    console.error("[chertog] open request", error);
  }
}

/** Listens for open requests while the overlay is mounted. */
export function useOpenRequests(target: OpenTarget): void {
  useEffect(() => {
    const listener = (event: Event) => handleOpenEvent(event, target);
    window.addEventListener(OPEN_EVENT, listener);
    return () => window.removeEventListener(OPEN_EVENT, listener);
  }, [target]);
}
