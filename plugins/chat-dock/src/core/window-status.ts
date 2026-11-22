// The window's status as BB sees it: no text, no conversation. The wire
// schema in contract.ts is checked against this type.

export type WindowPhase = "closed" | "building" | "open" | "unavailable";
export type WindowOutcomeView = "handed-off" | "unknown" | "refused" | "copied" | "cancelled";

export interface WindowStatusView {
  window: WindowPhase;
  reason: string | null;
  proposal: "none" | "waiting" | "writing";
  last: { proposalId: string; outcome: WindowOutcomeView } | null;
}

export type ProposeOutcome =
  | { ok: true; proposalId: string }
  | { ok: false; reason: "busy" | "empty-text" | "text-too-long" | "window-unavailable" };
