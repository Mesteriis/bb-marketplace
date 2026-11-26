// Makosh GitWand — BB backend entry.
//
// Composition root. Step 1 of the plan is the package skeleton: the core
// (stdio protocol with gitwand-bridge, UI routes, iframe URL) and the frame
// component exist and are tested, but no surface is registered yet. The
// bridge process, the UI routes and the WebSocket relay come with the
// runtime build (plan step 2) and the adapters (step 3).
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(_bb: BbPluginApi): void {}
