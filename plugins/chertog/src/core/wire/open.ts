// The public request that asks an open Chertog page to show a tile.
// Same document, synchronous: the sender dispatches a CustomEvent named
// OPEN_EVENT on `window` whose `detail` is a request; the page answers by
// writing `accepted` and `outcome` into that same object before dispatch
// returns. Pure TypeScript and zod; see docs/open-wire-v1.md.
import { z } from "zod";
import { panelRefSchema } from "../panels/ref.ts";

export const OPEN_EVENT = "chertog.open.v1";

/** What the page reports. */
export const OPEN_OUTCOMES = ["opened", "focused", "refused", "not-shown", "unsupported", "invalid"] as const;
export type OpenOutcome = (typeof OPEN_OUTCOMES)[number];

/** Outcomes with which the page handled the request; a sender falls back to its own default otherwise. */
export function isAcceptedOutcome(outcome: OpenOutcome): boolean {
  return outcome === "opened" || outcome === "focused" || outcome === "refused";
}

const unanswered = { accepted: z.literal(false), outcome: z.null() };

/** A request as the sender builds it: not answered yet. */
export const openRequestSchema = z.union([
  z.strictObject({ kind: z.literal("thread"), threadId: z.string().min(1).max(200), ...unanswered }),
  z.strictObject({ kind: z.literal("panel"), ref: panelRefSchema, ...unanswered }),
]);
export type OpenRequest = z.infer<typeof openRequestSchema>;
