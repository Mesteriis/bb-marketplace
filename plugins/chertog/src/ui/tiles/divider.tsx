// The handle in the gap between two children of a split: dragged with the
// pointer, moved with the arrow keys. The gap is the divider's whole box (6 px
// across), clear until hovered or focused.
import type { KeyboardEvent, PointerEvent } from "react";
import type { DividerRect } from "../../core/layout/index.ts";
import { rectStyle } from "./styles.ts";

/** How far one arrow key press moves a divider, in pixels. */
export const DIVIDER_KEY_STEP = 16;

export interface DividerProps {
  readonly divider: DividerRect;
  /** Share of the child before the divider in the pair it separates, 0 to 100. */
  readonly position: number;
  readonly label: string;
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  /** Move by `delta` pixels, right or down when positive. */
  onNudge(delta: number): void;
}

export function Divider({ divider, position, label, onPointerDown, onNudge }: DividerProps) {
  const row = divider.direction === "row";

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const back = row ? "ArrowLeft" : "ArrowUp";
    const forward = row ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    onNudge(event.key === forward ? DIVIDER_KEY_STEP : -DIVIDER_KEY_STEP);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={position}
      data-divider={divider.splitId + "#" + divider.index}
      style={{ ...rectStyle(divider.rect), cursor: row ? "col-resize" : "row-resize", touchAction: "none" }}
      className="rounded-full bg-transparent transition-colors hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none motion-reduce:transition-none"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
