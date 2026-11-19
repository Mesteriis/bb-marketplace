// noVNC is a large lazily loaded chunk. Loading it only when the first graphical view mounts made the first console of a page
// session slow: Proxmox's VNC proxy gives up on a viewer that has not answered the server's greeting within about ten seconds.
// The page starts the load as soon as a graphical console is asked for (`preloadNovnc`), in parallel with the open, and the view
// awaits the same promise.
import type RfbType from "@novnc/novnc/core/rfb.js";

let loading: Promise<typeof RfbType> | null = null;

export function loadNovnc(): Promise<typeof RfbType> {
  loading ??= import("@novnc/novnc/core/rfb.js").then((m) => m.default);
  // A failed load is not kept: the next use tries again.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Starts the load now; never throws. */
export function preloadNovnc(): void {
  void loadNovnc().catch(() => undefined);
}
