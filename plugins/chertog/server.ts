// Chertog — BB backend entry.
//
// Composition root for the BB server. The scaffold has no settings, RPC,
// storage, routes or agent tools, so loading the plugin registers nothing.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(_bb: BbPluginApi): void {}
