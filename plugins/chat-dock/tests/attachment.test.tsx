// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_ATTACHMENT, type Attachment } from "../src/core/attachment.ts";
import { measureAttachment } from "../src/ui/measure.ts";
import { POLL_MS, useAttachment } from "../src/ui/use-attachment.ts";

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
    expect(measureAttachment(element({ left: 10.004, top: 48, width: 700, height: 600 }), VIEW, true)).toEqual({
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
    expect(measureAttachment(element({ left: 0, top: 0, width: 700, height: 600 }), VIEW, false)).toEqual(HIDDEN_ATTACHMENT);
    expect(measureAttachment(null, VIEW, true)).toEqual(HIDDEN_ATTACHMENT);
    expect(measureAttachment(element({ left: 0, top: 0, width: 0, height: 600 }), VIEW, true)).toEqual(HIDDEN_ATTACHMENT);
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
    expect(sent.filter((v) => v.visible)).toHaveLength(1);

    Object.defineProperty(window, "screenX", { configurable: true, value: 333 });
    act(() => {
      vi.advanceTimersByTime(POLL_MS);
    });
    expect(sent[sent.length - 1]!.screenX).toBe(333);

    view.unmount();
    expect(sent[sent.length - 1]).toEqual(HIDDEN_ATTACHMENT);
  });
});
