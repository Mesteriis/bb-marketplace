// One visit to the stock Home: from the screen appearing to it going away.
// A visit takes the pass once and is decided once, so a redirect cannot
// repeat and a screen the pass let through is not redirected later.
import { decideHomeRedirect, type HomeArrivalFacts, type HomeRedirectDecision } from "./decision.ts";
import type { NewThreadPass } from "./new-thread-pass.ts";

export interface HomePresence {
  /** A mount of the Home screen appeared. */
  enter(): void;
  /** A mount of the Home screen went away. */
  leave(): void;
  /**
   * End the visit when no mount is left. Call it after the update that
   * called `leave` has finished: a host that swaps one mount for another in
   * a single update continues the same visit.
   */
  settle(): void;
  /**
   * Decide the current visit. `redirect` is returned at most once per visit;
   * after a decision every further call returns `stay` with `decided`.
   * `wait` decides nothing.
   */
  observe(facts: HomeArrivalFacts, now: number): HomeRedirectDecision;
}

interface Visit {
  newThreadPass: boolean;
  decided: boolean;
}

export function createHomePresence(pass: NewThreadPass): HomePresence {
  let mounts = 0;
  let visit: Visit | null = null;
  return {
    enter() {
      mounts += 1;
    },
    leave() {
      if (mounts > 0) mounts -= 1;
    },
    settle() {
      if (mounts === 0) visit = null;
    },
    observe(facts, now) {
      if (mounts === 0) return { action: "stay", reason: "not-home" };
      visit ??= { newThreadPass: pass.consume(now), decided: false };
      if (visit.decided) return { action: "stay", reason: "decided" };
      const decision = decideHomeRedirect({ ...facts, newThreadPass: visit.newThreadPass });
      if (decision.action !== "wait") visit.decided = true;
      return decision;
    },
  };
}
