// A provider inside a live host sees the drop first. Stop the browser's
// navigation and prevent an enclosing BB surface from selecting another draft.
import type { DragEvent } from "react";

export function containFileDrop(event: DragEvent<HTMLElement>): void {
  if (!event.dataTransfer.types.includes("Files")) return;
  if (!event.defaultPrevented) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  }
  event.stopPropagation();
}
