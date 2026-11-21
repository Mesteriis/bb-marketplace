// What the Chertog route tells the window's live layer. BB unmounts a nav
// panel when the user leaves its route and mounts a new one on return
// (observed on BB 0.50.1), so live panels cannot live inside the route. The
// route only reports where its tile surface is and where each panel's
// content area lies in it; the layer, mounted once per window, places the
// panels there and hides them while no route reports a surface.
import type { Rect } from "../../../core/layout/index.ts";
import { Listeners } from "./content-sources.ts";

/** The tile surface in viewport pixels. */
export interface SurfaceBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SurfacePlace {
  readonly box: SurfaceBox;
  /** Content rectangle of every visible active tab, by panel id, in surface pixels. */
  readonly rects: ReadonlyMap<string, Rect>;
  /**
   * Panels whose tile has a menu open over the content area. The layer is
   * drawn above the surface, so it steps aside for the menu.
   */
  readonly covered: ReadonlySet<string>;
  /** A divider or a tile is being dragged: live content lets the pointer through, and a drag shows the drop preview under it. */
  readonly gesture: "none" | "resize" | "drag";
}

const NO_RECTS: ReadonlyMap<string, Rect> = new Map();
const NO_PANELS: ReadonlySet<string> = new Set();

function sameBox(a: SurfaceBox, b: SurfaceBox): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

export class SurfaceBridge {
  /** The route that owns the surface now. A second Chertog pane of the same window gets none. */
  private owner: object | null = null;
  private place: SurfacePlace | null = null;
  private readonly listeners = new Listeners();

  subscribe = this.listeners.subscribe;

  /** The surface on screen, or `null` when the window shows no Chertog route. */
  getPlace = (): SurfacePlace | null => this.place;

  /** Takes the surface for a route. False when another route of this window already has it. */
  claim(owner: object): boolean {
    if (this.owner !== null && this.owner !== owner) return false;
    this.owner = owner;
    return true;
  }

  release(owner: object): void {
    if (this.owner !== owner) return;
    this.owner = null;
    if (this.place !== null) {
      this.place = null;
      this.listeners.notify();
    }
  }

  isOwner(owner: object): boolean {
    return this.owner === owner;
  }

  update(owner: object, patch: Partial<SurfacePlace>): void {
    if (this.owner !== owner) return;
    const current = this.place ?? { box: { left: 0, top: 0, width: 0, height: 0 }, rects: NO_RECTS, covered: NO_PANELS, gesture: "none" as const };
    const next: SurfacePlace = { ...current, ...patch };
    if (
      this.place !== null &&
      sameBox(next.box, current.box) &&
      next.rects === current.rects &&
      next.covered === current.covered &&
      next.gesture === current.gesture
    ) {
      return;
    }
    this.place = next;
    this.listeners.notify();
  }
}
