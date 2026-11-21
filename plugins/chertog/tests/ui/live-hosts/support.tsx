// Shared pieces of the live host tests: a content probe that counts its own
// mounts and unmounts, and shorthand for the layer's inputs.
import { useEffect } from "react";
import type { Rect } from "../../../src/core/layout/index.ts";
import { FramePanel, type LiveHostInstance } from "../../../src/ui/live-hosts/index.ts";

export interface Lifecycle {
  mounts: number;
  unmounts: number;
  renders: number;
}

export function lifecycle(): Lifecycle {
  return { mounts: 0, unmounts: 0, renders: 0 };
}

/** Live content with state a remount would lose: an uncontrolled textarea and an iframe. */
export function Probe({ instanceId, counter }: { instanceId: string; counter: Lifecycle }) {
  counter.renders += 1;
  useEffect(() => {
    counter.mounts += 1;
    return () => {
      counter.unmounts += 1;
    };
  }, [counter]);
  return (
    <div data-testid={"content-" + instanceId}>
      <textarea aria-label={"draft " + instanceId} defaultValue="" />
      <FramePanel src={"https://frame.test/" + instanceId} title={"frame " + instanceId} />
    </div>
  );
}

/** An instance whose `renderContent` keeps one identity for the whole test, as a real caller's does. */
export function probeInstance(instanceId: string, panelId: string, counter: Lifecycle): LiveHostInstance {
  return {
    instanceId,
    panelId,
    renderContent: (id) => <Probe instanceId={id} counter={counter} />,
  };
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function rects(entries: Record<string, Rect>): ReadonlyMap<string, Rect> {
  return new Map(Object.entries(entries));
}

export function layerRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>("[data-live-host-layer]");
  if (root === null) throw new Error("the live host layer is not rendered");
  return root;
}

export function host(container: HTMLElement, instanceId: string): HTMLElement {
  const found = container.querySelectorAll<HTMLElement>('[data-live-host="' + instanceId + '"]');
  if (found.length !== 1) throw new Error("expected one host for " + instanceId + ", found " + found.length);
  return found[0] as HTMLElement;
}

/** Instance IDs of the layer's DOM children, in DOM order. */
export function hostOrder(container: HTMLElement): string[] {
  return Array.from(layerRoot(container).children).map((child) => child.getAttribute("data-live-host") ?? "<not a host>");
}

export function frameOf(element: HTMLElement): HTMLIFrameElement {
  const frame = element.querySelector("iframe");
  if (frame === null) throw new Error("no iframe inside the host");
  return frame;
}

export function draftOf(element: HTMLElement): HTMLTextAreaElement {
  const draft = element.querySelector("textarea");
  if (draft === null) throw new Error("no textarea inside the host");
  return draft;
}
