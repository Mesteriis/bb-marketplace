// Whether an arrival on BB's stock Home is sent on to Chertog. A pure rule
// over facts the host adapter gathers; it reads no host state itself.

/** The owner's setting. `unknown` while the host has not delivered settings yet. */
export type HomeRedirectSetting = "on" | "off" | "unknown";

/** `stock-home` is BB's new thread screen, which is also where the stock Home lands by default. */
export type HomeSurface = "stock-home" | "other";

export interface HomeRedirectFacts {
  setting: HomeRedirectSetting;
  surface: HomeSurface;
  /** Chertog's own New thread action announced this arrival. */
  newThreadPass: boolean;
  /** The project the screen was opened for; null on the plain Home. */
  projectId: string | null;
  /** The screen is one pane of a split the user arranged. */
  split: boolean;
}

/** Everything the rule needs except the pass, which the visit takes itself. */
export type HomeArrivalFacts = Omit<HomeRedirectFacts, "newThreadPass">;

export type HomeStayReason = "not-home" | "disabled" | "new-thread-pass" | "project" | "split" | "decided";

export type HomeRedirectDecision =
  | { action: "redirect" }
  | { action: "stay"; reason: HomeStayReason }
  /** The setting is not known yet: nothing is decided and the stock Home stays. */
  | { action: "wait" };

/**
 * Redirect only an arrival nothing marks as intended: the setting is on, the
 * surface is the stock Home, no pass, no project, no split. Every doubt keeps
 * the stock screen, so a wrong fact costs a missed redirect, never a lost
 * new thread screen.
 */
export function decideHomeRedirect(facts: HomeRedirectFacts): HomeRedirectDecision {
  if (facts.surface !== "stock-home") return { action: "stay", reason: "not-home" };
  if (facts.setting === "off") return { action: "stay", reason: "disabled" };
  if (facts.setting === "unknown") return { action: "wait" };
  if (facts.newThreadPass) return { action: "stay", reason: "new-thread-pass" };
  if (facts.projectId !== null) return { action: "stay", reason: "project" };
  if (facts.split) return { action: "stay", reason: "split" };
  return { action: "redirect" };
}
