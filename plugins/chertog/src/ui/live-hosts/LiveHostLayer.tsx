// The layer that owns the DOM of live panels (docs/spec.md, section 4,
// "Стабильный host").
//
// A live panel (an iframe with a call, a terminal, a chat with a draft) loses
// its state when its DOM node is removed or moved: moving an iframe to
// another parent reloads the page. So live content is not rendered inside
// the tile tree. It is rendered here, in one flat list of containers under
// one parent, and the tile tree only says where each panel's content area is.
//
// What stays fixed for the life of an instance:
// - one container, keyed by `instanceId`, a direct child of the layer root;
// - its place among the root's children, which is the order of opening.
//   Stacking is done with z-index, never by reordering children;
// - its content, mounted once and unmounted only when the instance leaves
//   the `instances` list.
// A rebuild of the layout changes only the container's left, top, width,
// height and visibility.
import { containFileDrop } from "../tiles/file-drop.ts";
import { Component, memo, Suspense, useState, type CSSProperties, type ReactNode } from "react";
import type { Rect } from "../../core/layout/index.ts";
import { PanelStateView } from "./PanelStateView.tsx";
import { EMPTY_HOST_BOX, hostBox, sameHostBox, type HostBox } from "./placement.ts";

export interface LiveHostInstance {
  /** Identity of the live content. The same ID means the same container and the same mounted content. */
  instanceId: string;
  /** The panel that shows this instance now. May change: the instance then follows the other panel's rectangle. */
  panelId: string;
  /** A bound provider owns a draft and handles the file inside its own subtree. */
  readonly acceptsFileDrop?: boolean;
  /**
   * Renders the content; receives `instanceId`. Keep the function's identity
   * stable to skip re-renders of the content; a new function re-renders it
   * in place and does not remount it.
   */
  renderContent: (instanceId: string) => ReactNode;
}

export interface LiveHostLayerProps {
  /**
   * Every open live instance, shown or not. Leaving this list is the
   * explicit close: the container is removed and its content unmounted.
   * An `instanceId` listed twice is rendered once, from its first entry.
   */
  instances: readonly LiveHostInstance[];
  /**
   * Content area of each panel that is on screen, by `panelId`, in pixels of
   * the layer. A panel that is not on screen (a background tab, another named
   * layout, a maximized neighbour, compact mode) has no entry: its instance
   * stays mounted and is hidden.
   */
  rects: ReadonlyMap<string, Rect>;
  /** z-index of a panel's container inside the layer, by `panelId`. 0 when absent. */
  layers?: ReadonlyMap<string, number>;
  /**
   * True while a drag or a resize is in progress. Containers stop taking the
   * pointer, so an iframe under the cursor cannot swallow the gesture.
   */
  gestureActive?: boolean;
  /** Called once when an instance's content throws while rendering. The instance then shows the "lost" state. */
  onContentError?: (instanceId: string, error: unknown) => void;
}

// The root covers the work area and takes no pointer events itself, so tiles,
// dividers and drop zones under it stay reachable; containers switch the
// pointer back on for themselves. `isolation` with z-index 0 keeps the
// containers' z-indexes inside the layer: none of them can rise above a
// dialog or the command palette.
const ROOT_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 0,
  isolation: "isolate",
  overflow: "hidden",
  pointerEvents: "none",
};

/**
 * The instance IDs in opening order: those still open keep their places, new
 * ones go to the end. Returns `previous` itself when nothing changed.
 */
function openingOrder(previous: readonly string[], instances: readonly LiveHostInstance[]): readonly string[] {
  const open = new Set(instances.map((instance) => instance.instanceId));
  const next = previous.filter((id) => open.has(id));
  const placed = new Set(next);
  for (const { instanceId } of instances) {
    if (placed.has(instanceId)) continue;
    placed.add(instanceId);
    next.push(instanceId);
  }
  const unchanged = next.length === previous.length && next.every((id, index) => id === previous[index]);
  return unchanged ? previous : next;
}

export function LiveHostLayer({ instances, rects, layers, gestureActive = false, onContentError }: LiveHostLayerProps) {
  const [order, setOrder] = useState<readonly string[]>(() => openingOrder([], instances));
  // State derived from props during render: React re-renders at once with the
  // new order, before anything reaches the DOM.
  const current = openingOrder(order, instances);
  if (current !== order) setOrder(current);

  const byId = new Map<string, LiveHostInstance>();
  for (const instance of instances) {
    if (!byId.has(instance.instanceId)) byId.set(instance.instanceId, instance);
  }

  return (
    <div data-live-host-layer data-chertog-embed-layer="v1" style={ROOT_STYLE}>
      {current.map((instanceId) => {
        const instance = byId.get(instanceId);
        if (instance === undefined) return null;
        return (
          <LiveHost
            key={instanceId}
            instance={instance}
            rect={rects.get(instance.panelId)}
            zIndex={layers?.get(instance.panelId) ?? 0}
            gestureActive={gestureActive}
            onContentError={onContentError}
          />
        );
      })}
    </div>
  );
}

interface LiveHostProps {
  instance: LiveHostInstance;
  rect: Rect | undefined;
  zIndex: number;
  gestureActive: boolean;
  onContentError: ((instanceId: string, error: unknown) => void) | undefined;
}

function LiveHost({ instance, rect, zIndex, gestureActive, onContentError }: LiveHostProps) {
  const box = rect === undefined ? null : hostBox(rect);
  // A hidden host keeps the size it last had on screen: shrinking it would
  // make the content lay itself out again (a terminal would re-wrap its lines).
  const [lastBox, setLastBox] = useState<HostBox>(box ?? EMPTY_HOST_BOX);
  if (box !== null && !sameHostBox(box, lastBox)) setLastBox(box);
  const visible = box !== null;
  const shown = box ?? lastBox;

  // Hidden is `visibility: hidden`, never `display: none`: a frame without a
  // box may be throttled or lose scroll position and media state.
  const style: CSSProperties = {
    position: "absolute",
    left: shown.left,
    top: shown.top,
    width: shown.width,
    height: shown.height,
    zIndex,
    overflow: "hidden",
    // The tile's border curves at the bottom; the content follows it, one border width inside.
    borderBottomLeftRadius: "calc(var(--radius) - 1px)",
    borderBottomRightRadius: "calc(var(--radius) - 1px)",
    visibility: visible ? "visible" : "hidden",
    pointerEvents: visible && !gestureActive ? "auto" : "none",
  };

  return (
    <div
      data-live-host={instance.instanceId}
      onDragOverCapture={visible && instance.acceptsFileDrop ? undefined : containFileDrop}
      onDropCapture={visible && instance.acceptsFileDrop ? undefined : containFileDrop}
      onDragOver={containFileDrop}
      onDrop={containFileDrop}
      data-panel-id={instance.panelId}
      data-visible={visible ? "true" : "false"}
      inert={!visible}
      aria-hidden={visible ? undefined : true}
      style={style}
    >
      <ContentFailureBoundary instanceId={instance.instanceId} onContentError={onContentError}>
        <Suspense fallback={<PanelStateView state="loading" />}>
          <HostContent instanceId={instance.instanceId} renderContent={instance.renderContent} />
        </Suspense>
      </ContentFailureBoundary>
    </div>
  );
}

/** Memoized on the instance ID and the render function, so a change of geometry does not re-render the content. */
const HostContent = memo(function HostContent({
  instanceId,
  renderContent,
}: Pick<LiveHostInstance, "instanceId" | "renderContent">) {
  return renderContent(instanceId);
});

interface ContentFailureBoundaryProps {
  instanceId: string;
  onContentError: ((instanceId: string, error: unknown) => void) | undefined;
  children: ReactNode;
}

/**
 * Keeps a crash of one instance's content inside its own container. Without
 * it the error would unmount the whole layer and every neighbour with it.
 * The crashed content is gone, so the container says "lost"; the retry click
 * mounts the content anew.
 */
class ContentFailureBoundary extends Component<ContentFailureBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onContentError?.(this.props.instanceId, error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <PanelStateView state="lost" onRetry={() => this.setState({ failed: false })} />;
  }
}
