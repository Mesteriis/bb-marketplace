// Where the BB page wants the ChatGPT window: the page's reserved area and
// its viewport, in the page's own CSS pixels, plus what the window needs to
// find the page's window on screen. Carries no content.

export interface Attachment {
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

export const HIDDEN_ATTACHMENT: Attachment = {
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

export function sameAttachment(a: Attachment, b: Attachment): boolean {
  return (Object.keys(a) as Array<keyof Attachment>).every((key) => a[key] === b[key]);
}
