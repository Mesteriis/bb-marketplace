// The address of the controlled frame page (assets/fixtures/live-frame.html).
// The server mounts it on one route of the plugin; a window builds the iframe
// address from the plugin id the host gives it.

/** The route of the page inside the plugin's HTTP namespace. */
export const LIVE_FRAME_ROUTE = "/fixtures/live-frame.html";

const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The instance names the page accepts. */
const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The iframe address of the page, relative to the origin BB is served from.
 * `instance` gives the frame its own load counters: two frames of one origin
 * share storage.
 */
export function liveFrameUrlPath(pluginId: string, instance?: string): string {
  if (!PLUGIN_ID.test(pluginId)) throw new Error("The plugin id is not an identifier");
  if (instance !== undefined && !INSTANCE.test(instance)) {
    throw new Error("The frame instance is 1 to 64 letters, digits, - and _");
  }
  const path = "/api/v1/plugins/" + pluginId + "/http" + LIVE_FRAME_ROUTE;
  return instance === undefined ? path : path + "?instance=" + instance;
}
