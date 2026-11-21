// Turns the core's decision about a Home visit into one BB navigation.
import {
  createHomePresence,
  type HomeArrivalFacts,
  type HomeRedirectDecision,
  type NewThreadPass,
} from "../../../core/home/index.ts";

/** The part of `useBbNavigate()` the redirect uses. */
export interface HomeRedirectNavigation {
  toPluginPanel(path: string, options?: { subPath?: string; replace?: boolean }): void;
}

export interface HomeRedirectControllerOptions {
  /** `path` of the Chertog `navPanel`, as registered. */
  panelPath: string;
  pass: NewThreadPass;
  /** Milliseconds; `Date.now` unless a test supplies a clock. */
  now?: () => number;
  /** Runs a task after the current update; `queueMicrotask` unless a test supplies a queue. */
  defer?: (task: () => void) => void;
}

export interface HomeRedirectController {
  /** The Home section mounted. Returns the cleanup to call when it unmounts. */
  mount(): () => void;
  /**
   * Report what the mounted section sees. Navigates to the Chertog panel
   * at most once per visit, replacing the Home history entry so Back does
   * not return to a screen that redirects again.
   */
  observe(facts: HomeArrivalFacts, navigate: HomeRedirectNavigation): HomeRedirectDecision;
}

export function createHomeRedirectController(options: HomeRedirectControllerOptions): HomeRedirectController {
  const { panelPath, pass, now = Date.now, defer = queueMicrotask } = options;
  if (panelPath.trim() === "" || panelPath !== panelPath.trim() || panelPath.startsWith("/") || panelPath.endsWith("/")) {
    throw new RangeError("Chertog panel path must be a nav panel path without surrounding slashes or spaces");
  }
  const presence = createHomePresence(pass);
  return {
    mount() {
      presence.enter();
      let mounted = true;
      return () => {
        if (!mounted) return;
        mounted = false;
        presence.leave();
        // React runs the cleanup of a replaced mount and the setup of its
        // replacement in one update. Ending the visit after that update
        // keeps a remounted section in the visit it belongs to.
        defer(() => presence.settle());
      };
    },
    observe(facts, navigate) {
      const decision = presence.observe(facts, now());
      if (decision.action === "redirect") navigate.toPluginPanel(panelPath, { replace: true });
      return decision;
    },
  };
}
