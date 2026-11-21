// The window's layer of live panels. BB mounts it once per window, outside
// the routes, so a panel opened in Chertog keeps its DOM while the user
// visits a thread and comes back. It draws nothing but the panel containers,
// inside the rectangle the route measured for its tile surface, and hides
// them while the window shows no Chertog route. It takes no pointer events
// itself and has no z-index, so BB's palette, dialogs and sidebar stay above
// and reachable.
import { useCallback, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { Rect } from "../../../core/layout/index.ts";
import type { Diagnostics } from "../../../core/panels/index.ts";
import { LiveHostLayer, type LiveHostInstance } from "../../../ui/live-hosts/index.ts";
import { PanelContent } from "./PanelContent.tsx";
import type { SurfaceBox } from "./surface-bridge.ts";
import type { WindowWorkspace } from "./window-workspace.ts";

const NO_RECTS: ReadonlyMap<string, Rect> = new Map();

/** How much of the live content shows while a tile is dragged over it: the drop preview lies under the layer. */
const DRAG_OPACITY = 0.35;

export interface LiveLayerProps {
  readonly workspace: WindowWorkspace;
  readonly diagnostics?: Diagnostics;
}

export function LiveLayer({ workspace, diagnostics }: LiveLayerProps) {
  const { session, bridge } = workspace;
  useSyncExternalStore(session.subscribe, session.getVersion);
  const place = useSyncExternalStore(bridge.subscribe, bridge.getPlace);
  // Off the route the layer keeps the box it last had: the hidden hosts keep their size with it.
  const [lastBox, setLastBox] = useState<SurfaceBox>({ left: 0, top: 0, width: 0, height: 0 });
  if (place !== null && place.box !== lastBox) setLastBox(place.box);
  const box = place?.box ?? lastBox;

  const renderContent = useCallback((instanceId: string): ReactNode => <PanelContent session={session} instanceId={instanceId} />, [session]);
  const instances: LiveHostInstance[] = session.registry.list().flatMap((instance) => {
    const panelId = session.panelOfInstance(instance.instanceId);
    return panelId === null ? [] : [{ instanceId: instance.instanceId, panelId, renderContent }];
  });
  const rects = useMemo(() => {
    if (place === null) return NO_RECTS;
    if (place.covered.size === 0) return place.rects;
    return new Map([...place.rects].filter(([panelId]) => !place.covered.has(panelId)));
  }, [place]);

  const style: CSSProperties = {
    position: "fixed",
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    pointerEvents: "none",
    ...(place?.gesture === "drag" ? { opacity: DRAG_OPACITY } : {}),
  };
  return (
    <div data-chertog-live-layer={place === null ? "parked" : "shown"} style={style}>
      <LiveHostLayer
        instances={instances}
        rects={rects}
        gestureActive={place !== null && place.gesture !== "none"}
        onContentError={(instanceId, error) => diagnostics?.failure("chertog-panel-content:" + instanceId, error)}
      />
    </div>
  );
}
