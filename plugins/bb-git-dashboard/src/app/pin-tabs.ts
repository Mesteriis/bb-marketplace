import { pullPin, samePull, type PullPin } from "../core/panel/pins.ts";

/** What pinning and unpinning use of BB's panel controller (`experimental_useAppPanel()`). */
export type PinPanel<T extends Tab = Tab> = {
  getTabs(): {tabs: readonly {key: string; detail: {kind: string; tab?: {id: string}; params?: unknown}}[]};
  selectTab(key: string): boolean;
  closeTab(key: string): boolean;
  openTab(options: {tab: T; params: {[key: string]: string | number}; title: string}): boolean;
};
type Tab = {id: string};
type Listing = Pick<PinPanel, "getTabs">;

const pluginTabs = (panel: Listing, tab: Tab) => panel.getTabs().tabs.filter(item => item.detail.kind === "plugin" && item.detail.tab?.id === tab.id);

/** Closes this plugin's open tab with these params (Unpin); false when it is not open any more. Keys are read, never kept. */
export function unpinTab(panel: Pick<PinPanel, "getTabs" | "closeTab">, tab: Tab, params: unknown): boolean {
  const same = JSON.stringify(params ?? null);
  const open = pluginTabs(panel, tab).find(item => JSON.stringify(item.detail.params ?? null) === same);
  return open ? panel.closeTab(open.key) : false;
}

/**
 * Pins a pull request as its own tab, or selects the tab that already shows it — a pin made before 0.14.7 keeps the
 * repository's id only, and `pathOf` reads that id's path to compare. Throws when the panel takes neither.
 */
export async function pinPullTab<T extends Tab>(panel: PinPanel<NoInfer<T>>, tab: T, pull: {accountId: string; repo: string; number: number}, title: string,
  pathOf: (accountId: string, repoId: string) => Promise<string | null>): Promise<"opened" | "selected"> {
  const wanted: PullPin = {accountId: pull.accountId, repo: pull.repo, repoId: null, number: pull.number};
  for (const item of pluginTabs(panel, tab)) {
    const pin = pullPin(item.detail.params);
    if (!pin || pin.accountId !== wanted.accountId || pin.number !== wanted.number) continue;
    const known = pin.repo || !pin.repoId ? pin : {...pin, repo: await pathOf(pin.accountId, pin.repoId).catch(() => null)};
    if (samePull(wanted, known) && panel.selectTab(item.key)) return "selected";
  }
  if (!panel.openTab({tab, params: {accountId: pull.accountId, repo: pull.repo, number: pull.number}, title})) throw new Error("PANEL_DECLINED");
  return "opened";
}
