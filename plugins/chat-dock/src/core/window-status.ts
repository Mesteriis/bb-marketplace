// The window's status as BB sees it: whether it is open, and why not.
// The wire schema in contract.ts is checked against this type.

export type WindowPhase = "closed" | "building" | "open" | "unavailable";

export interface WindowStatusView {
  window: WindowPhase;
  reason: string | null;
}
