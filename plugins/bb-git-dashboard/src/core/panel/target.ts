/** Where the Git panel beside a thread opens, and the rule that a target's command runs only once. No I/O. */

export type CiScreen = {kind: "runs"} | {kind: "run"; runId: string} | {kind: "templates"};
export type PanelScreen = {kind: "summary"} | {kind: "changes"; path?: string} | {kind: "ci"; view: CiScreen} | {kind: "review"} | {kind: "history"};
/** A header button, a palette command or the Info row asks for a screen; a Review command may come with it. */
export type GitTarget = {screen: "summary" | "changes" | "ci" | "review" | "history"; runId?: string; command?: string};

export function targetScreen(target: GitTarget): PanelScreen {
  if (target.screen === "ci") return {kind: "ci", view: target.runId ? {kind: "run", runId: target.runId} : {kind: "runs"}};
  return {kind: target.screen};
}

/**
 * True the first time a target (its sequence) is seen for a thread. BB keeps a fixed tab's target across remounts, so
 * without this a Review command (send to the agent, an AI review) would run again each time the tab comes back.
 */
export function firstTime(handled: Map<string, number>, thread: string, sequence: number): boolean {
  if (handled.get(thread) === sequence) return false;
  handled.set(thread, sequence);
  return true;
}

/** Back from a part's screen: the id of that part's heading in the summary, which takes the focus; null from nowhere. */
export function backFocus(from: Exclude<PanelScreen["kind"], "summary"> | null): string | null {
  return from ? "git-panel-" + from : null;
}
