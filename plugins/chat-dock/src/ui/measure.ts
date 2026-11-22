// Measures the area the page reserves for the ChatGPT window, in the page's
// CSS pixels, together with what the window needs to find this page's window.
import { hiddenFor, type Attachment } from "../core/attachment.ts";

export interface ViewportLike {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenX: number;
  screenY: number;
  devicePixelRatio: number;
}

export function measureAttachment(element: Element | null, view: ViewportLike, visible: boolean, owner: string): Attachment {
  if (element === null || !visible) return hiddenFor(owner);
  const box = element.getBoundingClientRect();
  // Only the part of the area that is inside the viewport.
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(view.innerWidth, box.left + box.width);
  const bottom = Math.min(view.innerHeight, box.top + box.height);
  if (right - left <= 0 || bottom - top <= 0) return hiddenFor(owner);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    owner,
    visible: true,
    x: round(left),
    y: round(top),
    width: round(right - left),
    height: round(bottom - top),
    innerWidth: view.innerWidth,
    innerHeight: view.innerHeight,
    outerWidth: view.outerWidth,
    outerHeight: view.outerHeight,
    screenX: view.screenX,
    screenY: view.screenY,
    pixelRatio: view.devicePixelRatio,
  };
}
