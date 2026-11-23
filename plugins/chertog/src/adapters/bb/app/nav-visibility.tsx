// Keeps Chertog's navigation entry in step with the «Тайловое пространство»
// switch through the host's own sidebar visibility, so BB's navigation and
// Makosh Navigation both honour it. It runs in the always-mounted overlay,
// because the switch off unmounts the workspace.
import { experimental_usePluginId, experimental_useSidebarNavigation } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { decideNavVisibility, type ItemState } from "../../../core/nav/index.ts";

const STORAGE_KEY = "chertog.navVisibility.tileSpace";

function readStored(): boolean | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "on" ? true : value === "off" ? false : null;
  } catch {
    return null;
  }
}

function writeStored(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
  } catch {
    // Without storage the next window start treats the switch as first run.
  }
}

/** Renders nothing; acts on a change of the switch, not on a render. */
export function NavVisibilityWatch({ panelId, tileSpace }: { panelId: string; tileSpace: boolean | null }) {
  const pluginId = experimental_usePluginId();
  const { items, actions } = experimental_useSidebarNavigation();
  const item = items.find((candidate) => candidate.pluginId === pluginId && candidate.id === `${pluginId}/${panelId}`);
  const state: ItemState = item === undefined ? "missing" : item.isVisible ? "visible" : "hidden";
  const itemId = item?.id;
  const setVisible = actions.setVisible;
  useEffect(() => {
    const decision = decideNavVisibility({ stored: readStored(), delivered: tileSpace, item: state });
    if (decision.setVisible !== null && itemId !== undefined) setVisible(itemId, decision.setVisible);
    if (decision.store !== null) writeStored(decision.store);
  }, [tileSpace, state, itemId, setVisible]);
  return null;
}
