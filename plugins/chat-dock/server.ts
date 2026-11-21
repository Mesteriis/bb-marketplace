// BB Chat Dock — BB backend entry.
//
// Empty on purpose. The plugin registers no RPC method, HTTP route, CLI
// command, agent tool, setting, schedule or storage: everything it does
// happens in the BB window, on the user's own click. An agent therefore has
// nothing of this plugin to call.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(_bb: BbPluginApi) {}
