// What BB's public SDK tells a homepage section about the screen it is on,
// in the core's terms.
import type { HomeArrivalFacts } from "../../../core/home/index.ts";

export interface HomeSectionView {
  /** The owner's setting; null while BB has not delivered settings. */
  enabled: boolean | null;
  /** `projectId` prop of the homepage section: the project in the route, null on the plain Home. */
  projectId: string | null;
  /** `useSidebarSplitLayout()`: null when nothing is split. */
  splitLayout: object | null;
}

/**
 * BB mounts homepage sections only on the new thread screen, which is also
 * the stock Home, so a section that renders is on `stock-home`.
 */
export function readHomeArrivalFacts(view: HomeSectionView): HomeArrivalFacts {
  return {
    setting: view.enabled === null ? "unknown" : view.enabled ? "on" : "off",
    surface: "stock-home",
    projectId: view.projectId,
    split: view.splitLayout !== null,
  };
}
