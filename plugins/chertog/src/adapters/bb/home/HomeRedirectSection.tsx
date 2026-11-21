// The homepage section that notices an arrival on BB's stock Home and sends
// it to Chertog. BB mounts homepage sections only on the new thread screen,
// so the section being rendered is the public signal that the screen is up.
import { useBbNavigate, useSidebarSplitLayout, type PluginHomepageSectionProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ComponentType } from "react";
import { createHomeRedirectController } from "./controller.ts";
import { readHomeArrivalFacts } from "./facts.ts";
import { newThreadPass } from "./new-thread.ts";
import { showsOpenChertogButton } from "./section-view.ts";
import type { HomeRedirectDecision } from "../../../core/home/index.ts";

export interface HomeRedirectSectionOptions {
  /** `path` of the Chertog `navPanel`, as registered. */
  panelPath: string;
  /**
   * A hook that reads the owner's setting: true or false, or null while BB
   * has not delivered settings. Null keeps the stock Home.
   */
  useRedirectEnabled: () => boolean | null;
  /** Text of the button shown when the setting is on and the visit stays on the stock screen. */
  openLabel: string;
}

/**
 * Build the component for `app.slots.homepageSection`. Call it once per
 * plugin app: the returned component shares one visit across its mounts.
 *
 * It redirects an accidental arrival with `replace`. With the setting on, a
 * visit that stays (Chertog's New thread action, a project, a split) shows
 * one button that opens Chertog. With the setting off it draws nothing.
 */
export function createHomeRedirectSection(options: HomeRedirectSectionOptions): ComponentType<PluginHomepageSectionProps> {
  const { panelPath, useRedirectEnabled, openLabel } = options;
  const controller = createHomeRedirectController({ panelPath, pass: newThreadPass });

  return function HomeRedirectSection({ projectId }: PluginHomepageSectionProps) {
    const enabled = useRedirectEnabled();
    const navigate = useBbNavigate();
    const splitLayout = useSidebarSplitLayout();
    const split = splitLayout !== null;
    const [decision, setDecision] = useState<HomeRedirectDecision | null>(null);

    useEffect(() => controller.mount(), []);

    useEffect(() => {
      const facts = readHomeArrivalFacts({ enabled, projectId, splitLayout });
      setDecision(controller.observe(facts, navigate));
      // The layout object changes with every pane resize; only whether a
      // split exists matters here.
    }, [enabled, projectId, split, navigate]);

    if (!showsOpenChertogButton(enabled, decision)) return null;
    return (
      <button
        type="button"
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        onClick={() => navigate.toPluginPanel(panelPath)}
      >
        {openLabel}
      </button>
    );
  };
}
