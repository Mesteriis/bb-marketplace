// What the homepage section draws on a visit that stays on the stock screen.
import type { HomeRedirectDecision } from "../../../core/home/index.ts";

/**
 * The section offers its "open Chertog" button only while the owner's
 * setting is on and the visit was let through. With the setting off or not
 * loaded the section draws nothing, so the stock Home carries no Chertog
 * control.
 */
export function showsOpenChertogButton(enabled: boolean | null, decision: HomeRedirectDecision | null): boolean {
  if (enabled !== true || decision === null) return false;
  return decision.action === "stay" && decision.reason !== "disabled";
}
