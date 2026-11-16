// bb-plugin-skills-sync — the BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
//
// The panel itself lives in components/sync/; this file only registers it.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SyncSidebarAccessory } from "@/components/sync/sidebar-accessory";
import { SyncPanel } from "@/components/sync/sync-panel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sync",
    title: "Skills Sync",
    icon: "RefreshCw",
    // Routed at /plugins/skills-sync/sync.
    path: "sync",
    component: SyncPanel,
    // A count on the sidebar row when skills are waiting on a decision.
    experimental_sidebarAccessory: SyncSidebarAccessory,
  });
});
