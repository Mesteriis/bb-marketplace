// Where the BB page wants the ChatGPT window: the page's reserved area and
// its viewport, in the page's own CSS pixels, plus what the window needs to
// find the page's window on screen. Carries no content.

export interface Attachment {
  /** A random id of the page instance that reports; hides count only from it. */
  owner: string;
  visible: boolean;
  /** The reserved area, relative to the page's viewport. */
  x: number;
  y: number;
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenX: number;
  screenY: number;
  pixelRatio: number;
}

export const MAX_OWNER_LENGTH = 64;

export const HIDDEN_ATTACHMENT: Attachment = {
  owner: "",
  visible: false,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  innerWidth: 1,
  innerHeight: 1,
  outerWidth: 1,
  outerHeight: 1,
  screenX: 0,
  screenY: 0,
  pixelRatio: 1,
};

export function hiddenFor(owner: string): Attachment {
  return { ...HIDDEN_ATTACHMENT, owner };
}

export function sameAttachment(a: Attachment, b: Attachment): boolean {
  return (Object.keys(a) as Array<keyof Attachment>).every((key) => a[key] === b[key]);
}

// Rounding in the page may push an edge past the viewport by a fraction.
const SLACK = 1;

/**
 * The area lies inside the page's viewport, and the viewport inside the
 * page's window: the ChatGPT window can never cover more than the page.
 */
export function insideViewport(a: Attachment): boolean {
  return (
    a.x >= 0 &&
    a.y >= 0 &&
    a.x + a.width <= a.innerWidth + SLACK &&
    a.y + a.height <= a.innerHeight + SLACK &&
    a.innerWidth <= a.outerWidth + SLACK &&
    a.innerHeight <= a.outerHeight + SLACK
  );
}

/**
 * The placement the window should follow after `next` arrives, or null to
 * ignore `next`. A visible placement from any page replaces the current one;
 * a hide counts only from the page that placed the window, so a page that
 * closes after another took over does not hide the newer page's window.
 */
export function acceptAttachment(current: Attachment | null, next: Attachment): Attachment | null {
  if (next.visible) return insideViewport(next) ? next : null;
  if (current === null || !current.visible || current.owner === next.owner) return next;
  return null;
}
