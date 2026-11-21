// The size of the surface: what the parent says, else what the container
// measures.
import { useLayoutEffect, useState, type RefObject } from "react";

export interface SurfaceSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The size to lay tiles out in, or `null` until the container has been
 * measured. A `fixed` size wins and nothing is observed: a parent that
 * already knows the rectangle passes it, and so do tests, where the DOM has
 * no layout.
 */
export function useSurfaceSize(container: RefObject<HTMLElement | null>, fixed: SurfaceSize | undefined): SurfaceSize | null {
  const [measured, setMeasured] = useState<SurfaceSize | null>(null);
  const observing = fixed === undefined;

  useLayoutEffect(() => {
    const element = container.current;
    if (!observing || element === null) return;
    const update = (width: number, height: number): void => {
      setMeasured((current) => (current !== null && current.width === width && current.height === height ? current : { width, height }));
    };
    // The observer reports the first size by itself, but only after paint; a
    // measurement now avoids one empty frame.
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) update(box.width, box.height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [container, observing]);

  return fixed ?? measured;
}
