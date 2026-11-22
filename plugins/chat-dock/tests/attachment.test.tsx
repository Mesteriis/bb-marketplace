// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptAttachment, hiddenFor, HIDDEN_ATTACHMENT, insideViewport, type Attachment } from "../src/core/attachment.ts";
import { attachmentSchema } from "../contract.ts";
import { measureAttachment } from "../src/ui/measure.ts";
import { HEARTBEAT_MS, POLL_MS, useAttachment } from "../src/ui/use-attachment.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const VIEW = { innerWidth: 1200, innerHeight: 800, outerWidth: 1260, outerHeight: 880, screenX: 30, screenY: 40, devicePixelRatio: 2 };

function element(box: { left: number; top: number; width: number; height: number }): Element {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) });
  return el;
}

describe("measuring the reserved area", () => {
  it("reports the area and the viewport as the page sees them", () => {
    expect(measureAttachment(element({ left: 10.004, top: 48, width: 700, height: 600 }), VIEW, true, "page-1")).toEqual({
      owner: "page-1",
      visible: true,
      x: 10,
      y: 48,
      width: 700,
      height: 600,
      innerWidth: 1200,
      innerHeight: 800,
      outerWidth: 1260,
      outerHeight: 880,
      screenX: 30,
      screenY: 40,
      pixelRatio: 2,
    });
  });

  it("hides the window for a hidden page, a missing area or an empty one", () => {
    const hidden = { ...HIDDEN_ATTACHMENT, owner: "page-1" };
    expect(measureAttachment(element({ left: 0, top: 0, width: 700, height: 600 }), VIEW, false, "page-1")).toEqual(hidden);
    expect(measureAttachment(null, VIEW, true, "page-1")).toEqual(hidden);
    expect(measureAttachment(element({ left: 0, top: 0, width: 0, height: 600 }), VIEW, true, "page-1")).toEqual(hidden);
  });

  it("cuts the area to the visible viewport", () => {
    expect(measureAttachment(element({ left: -20, top: 700, width: 700, height: 600 }), VIEW, true, "p")).toMatchObject({ x: 0, y: 700, width: 680, height: 100 });
  });
});

const PLACED: Attachment = { owner: "a", visible: true, x: 0, y: 40, width: 800, height: 600, innerWidth: 1200, innerHeight: 800, outerWidth: 1260, outerHeight: 880, screenX: 10, screenY: 20, pixelRatio: 2 };

describe("which placements the window takes", () => {
  it("takes only an area inside the page's viewport, inside the page's window", () => {
    expect(insideViewport(PLACED)).toBe(true);
    expect(insideViewport({ ...PLACED, x: 400, width: 800 })).toBe(true);
    expect(insideViewport({ ...PLACED, x: 401, width: 800 })).toBe(true); // 1 px rounding slack
    expect(insideViewport({ ...PLACED, x: 402, width: 800 })).toBe(false);
    expect(insideViewport({ ...PLACED, x: -1 })).toBe(false);
    expect(insideViewport({ ...PLACED, y: -5 })).toBe(false);
    expect(insideViewport({ ...PLACED, height: 762 })).toBe(false);
    expect(insideViewport({ ...PLACED, innerWidth: 1300, x: 0 })).toBe(false);
  });

  it("a visible placement replaces any other; a hide counts only from the page that placed it", () => {
    expect(acceptAttachment(null, PLACED)).toEqual(PLACED);
    const b = { ...PLACED, owner: "b", x: 10 };
    expect(acceptAttachment(PLACED, b)).toEqual(b);
    expect(acceptAttachment(b, hiddenFor("a"))).toBeNull();
    expect(acceptAttachment(b, hiddenFor("b"))).toEqual(hiddenFor("b"));
  });

  it("refuses an area outside the viewport, and the RPC schema refuses it too", () => {
    expect(acceptAttachment(PLACED, { ...PLACED, owner: "x", x: -300, width: 2000 })).toBeNull();
    expect(attachmentSchema.safeParse({ ...PLACED, x: -300, width: 2000 }).success).toBe(false);
    expect(attachmentSchema.safeParse({ ...PLACED, innerWidth: 2000 }).success).toBe(false);
    expect(attachmentSchema.safeParse(PLACED).success).toBe(true);
    expect(attachmentSchema.safeParse(hiddenFor("a")).success).toBe(true);
    expect(attachmentSchema.safeParse({ ...PLACED, owner: "x".repeat(65) }).success).toBe(false);
  });
});

describe("keeping the window on the area", () => {
  function Probe({ send, box }: { send: (view: Attachment) => void; box: { left: number; top: number; width: number; height: number } }) {
    const ref = useRef<HTMLDivElement>(null);
    useAttachment(ref, send, true);
    return (
      <div
        ref={(node) => {
          if (node !== null) node.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) });
          (ref as { current: HTMLDivElement | null }).current = node;
        }}
      />
    );
  }

  it("sends once per change, follows a moved window, and hides on unmount", () => {
    vi.useFakeTimers();
    const sent: Attachment[] = [];
    const view = render(<Probe send={(v) => void sent.push(v)} box={{ left: 0, top: 40, width: 600, height: 500 }} />);
    act(() => {
      vi.advanceTimersByTime(POLL_MS * 3);
    });
    expect(POLL_MS * 3).toBeLessThan(HEARTBEAT_MS);
    expect(sent.filter((v) => v.visible)).toHaveLength(1);

    Object.defineProperty(window, "screenX", { configurable: true, value: 333 });
    act(() => {
      vi.advanceTimersByTime(POLL_MS);
    });
    expect(sent[sent.length - 1]!.screenX).toBe(333);

    const owner = sent[0]!.owner;
    expect(owner.length).toBeGreaterThan(8);
    view.unmount();
    expect(sent[sent.length - 1]).toEqual(hiddenFor(owner));
  });

  it("repeats an unchanged placement, so a page whose window was taken over gets it back", () => {
    vi.useFakeTimers();
    const sent: Attachment[] = [];
    render(<Probe send={(v) => void sent.push(v)} box={{ left: 0, top: 40, width: 600, height: 500 }} />);
    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS + POLL_MS);
    });
    expect(sent.filter((v) => v.visible)).toHaveLength(2);
  });

  it("two pages carry different owners", () => {
    const a: Attachment[] = [];
    const b: Attachment[] = [];
    render(<Probe send={(v) => void a.push(v)} box={{ left: 0, top: 0, width: 600, height: 500 }} />);
    render(<Probe send={(v) => void b.push(v)} box={{ left: 0, top: 0, width: 600, height: 500 }} />);
    expect(a[0]!.owner).not.toBe(b[0]!.owner);
  });
});
