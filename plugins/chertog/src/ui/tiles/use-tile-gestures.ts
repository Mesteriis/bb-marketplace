// The two pointer gestures of the surface: dragging a divider and dragging a
// header or a tab. A gesture holds the pointer through pointer capture and
// lives entirely here until it is confirmed: the parent hears of it once, on
// release, and not at all when it is cancelled.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { DragSource, DropResolution, LayoutOptions, Point, Rect, SplitDirection, WorkspaceState } from "../../core/layout/index.ts";
import { resizeDivider, resolveDrop } from "../../core/layout/index.ts";

/** A press turns into a drag after the pointer has travelled this far, in pixels. */
export const DRAG_THRESHOLD = 4;

interface Held {
  readonly pointerId: number;
  /** The element that captured the pointer. */
  readonly element: Element;
  /** The state the gesture started from. A change from outside ends the gesture. */
  readonly base: WorkspaceState;
}

interface ResizeGesture extends Held {
  readonly kind: "resize";
  readonly splitId: string;
  readonly index: number;
  readonly axis: SplitDirection;
  /** Pointer position along the axis at the press, in client pixels. */
  readonly origin: number;
  /** `base` with the divider where the pointer is now. */
  readonly draft: WorkspaceState;
}

interface DragGesture extends Held {
  readonly kind: "drag";
  readonly source: DragSource;
  /** Where the press was, in client pixels. */
  readonly start: Point;
  /** False until the pointer passes the threshold; until then it may still be a click. */
  readonly active: boolean;
  /** Pointer position on the surface. */
  readonly point: Point;
}

type Gesture = ResizeGesture | DragGesture;

export interface TileGesturesInput {
  readonly state: WorkspaceState;
  readonly bounds: Rect;
  readonly options: LayoutOptions;
  /** Tabs and headers can be dragged only while every tile is on screen. */
  readonly canDrag: boolean;
  readonly surface: RefObject<HTMLElement | null>;
  /** A divider was released somewhere new. */
  onResized(state: WorkspaceState): void;
  /** A drag was dropped on a target that takes it. */
  onDropped(resolution: DropResolution): void;
  /** A press was released before it became a drag. */
  onClicked(source: DragSource): void;
}

type SurfacePointerEvent = ReactPointerEvent<HTMLElement>;

export interface TileGestures {
  /** The state to draw: the divider being dragged shows where it is now. */
  readonly shown: WorkspaceState;
  /** True from the moment a gesture can move something until it ends. */
  readonly engaged: boolean;
  /** What is being dragged, once the drag has started. */
  readonly dragging: DragSource | null;
  /** Where the dragged thing would land, or `null` over a target that does not take it. */
  readonly drop: DropResolution | null;
  beginResize(event: SurfacePointerEvent, splitId: string, index: number, axis: SplitDirection): void;
  beginDrag(event: SurfacePointerEvent, source: DragSource): void;
  /** Handlers for the surface element: captured pointer events bubble up to it. */
  readonly surfaceHandlers: {
    onPointerMove(event: SurfacePointerEvent): void;
    onPointerUp(event: SurfacePointerEvent): void;
    onPointerCancel(event: SurfacePointerEvent): void;
    onLostPointerCapture(event: SurfacePointerEvent): void;
  };
}

export function useTileGestures(input: TileGesturesInput): TileGestures {
  const { state, bounds, options, canDrag, surface } = input;
  const [gesture, setGesture] = useState<Gesture | null>(null);
  // Handlers read the gesture from here: a pointer event can arrive before
  // React has rendered the previous one.
  const current = useRef<Gesture | null>(null);

  const set = (next: Gesture | null): void => {
    current.current = next;
    setGesture(next);
  };

  /** Ends the gesture without telling the parent anything. */
  const end = (): void => {
    const held = current.current;
    if (held === null) return;
    set(null);
    if (held.element.hasPointerCapture(held.pointerId)) held.element.releasePointerCapture(held.pointerId);
  };

  const held = (event: SurfacePointerEvent): Gesture | null => {
    const candidate = current.current;
    return candidate !== null && candidate.pointerId === event.pointerId ? candidate : null;
  };

  const surfacePoint = (event: SurfacePointerEvent): Point => {
    const box = surface.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const resized = (resize: ResizeGesture, event: SurfacePointerEvent): WorkspaceState => {
    const position = resize.axis === "row" ? event.clientX : event.clientY;
    return resizeDivider(resize.base, resize.splitId, resize.index, position - resize.origin, bounds, options);
  };

  const begin = (event: SurfacePointerEvent): Held | null => {
    if (event.button !== 0 || current.current !== null) return null;
    event.currentTarget.setPointerCapture(event.pointerId);
    return { pointerId: event.pointerId, element: event.currentTarget, base: state };
  };

  const beginResize = (event: SurfacePointerEvent, splitId: string, index: number, axis: SplitDirection): void => {
    const start = begin(event);
    if (start === null) return;
    // No text selection and no focus change while the divider is held.
    event.preventDefault();
    set({ ...start, kind: "resize", splitId, index, axis, origin: axis === "row" ? event.clientX : event.clientY, draft: state });
  };

  const beginDrag = (event: SurfacePointerEvent, source: DragSource): void => {
    const start = begin(event);
    if (start === null) return;
    set({ ...start, kind: "drag", source, start: { x: event.clientX, y: event.clientY }, active: false, point: surfacePoint(event) });
  };

  const onPointerMove = (event: SurfacePointerEvent): void => {
    const moving = held(event);
    if (moving === null) return;
    if (moving.kind === "resize") {
      set({ ...moving, draft: resized(moving, event) });
      return;
    }
    if (!moving.active) {
      const travelled = Math.hypot(event.clientX - moving.start.x, event.clientY - moving.start.y);
      if (!canDrag || travelled < DRAG_THRESHOLD) return;
    }
    set({ ...moving, active: true, point: surfacePoint(event) });
  };

  const onPointerUp = (event: SurfacePointerEvent): void => {
    const released = held(event);
    if (released === null) return;
    end();
    if (released.kind === "resize") {
      const next = resized(released, event);
      if (next !== released.base) input.onResized(next);
    } else if (!released.active) {
      input.onClicked(released.source);
    } else {
      const resolution = resolveDrop(state, released.source, surfacePoint(event), bounds, options);
      if (resolution !== null) input.onDropped(resolution);
    }
  };

  const cancel = (event: SurfacePointerEvent): void => {
    if (held(event) !== null) end();
  };

  // The layout changed under the gesture: what it started from is gone.
  useEffect(() => {
    if (current.current !== null && current.current.base !== state) end();
  });

  const engaged = gesture !== null && (gesture.kind === "resize" || gesture.active);

  useEffect(() => {
    const view = surface.current?.ownerDocument;
    if (!engaged || view === undefined) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // The key cancels the gesture and nothing else: not a dialog, not a menu.
      event.preventDefault();
      event.stopPropagation();
      end();
    };
    view.addEventListener("keydown", onKeyDown, true);
    return () => view.removeEventListener("keydown", onKeyDown, true);
  }, [engaged, surface]);

  const dragging = gesture !== null && gesture.kind === "drag" && gesture.active ? gesture : null;

  return {
    shown: gesture !== null && gesture.kind === "resize" && gesture.base === state ? gesture.draft : state,
    engaged,
    dragging: dragging?.source ?? null,
    drop: dragging === null ? null : resolveDrop(state, dragging.source, dragging.point, bounds, options),
    beginResize,
    beginDrag,
    surfaceHandlers: { onPointerMove, onPointerUp, onPointerCancel: cancel, onLostPointerCapture: cancel },
  };
}
