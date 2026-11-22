// Measures the area the page reserves for the ChatGPT window, in the page's
// CSS pixels, together with what the window needs to find this page's window.
import { HIDDEN_ATTACHMENT, type Attachment } from "../core/attachment.ts";

export interface ViewportLike {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenX: number;
  screenY: number;
  devicePixelRatio: number;
}

export function measureAttachment(element: Element | null, view: ViewportLike, visible: boolean): Attachment {
  if (element === null || !visible) return HIDDEN_ATTACHMENT;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return HIDDEN_ATTACHMENT;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    visible: true,
    x: round(box.left),
    y: round(box.top),
    width: round(box.width),
    height: round(box.height),
    innerWidth: view.innerWidth,
    innerHeight: view.innerHeight,
    outerWidth: view.outerWidth,
    outerHeight: view.outerHeight,
    screenX: view.screenX,
    screenY: view.screenY,
    pixelRatio: view.devicePixelRatio,
  };
}
