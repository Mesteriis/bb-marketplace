// FramePanel: an iframe by URL whose address is set once. A new `src` or a
// remount would reload the page, which is exactly what a live panel must not do.
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FramePanel } from "../../../src/ui/live-hosts/index.ts";

function frame(container: HTMLElement): HTMLIFrameElement {
  const found = container.querySelectorAll("iframe");
  if (found.length !== 1) throw new Error("expected one iframe, found " + found.length);
  return found[0] as HTMLIFrameElement;
}

describe("FramePanel", () => {
  it("renders one iframe that fills its container", () => {
    const { container } = render(<FramePanel src="https://frame.test/live" title="Live page" />);
    const element = frame(container);

    expect(element.getAttribute("src")).toBe("https://frame.test/live");
    expect(element.getAttribute("title")).toBe("Live page");
    expect(element.style.width).toBe("100%");
    expect(element.style.height).toBe("100%");
    expect(element.style.borderWidth).toBe("0px");
    expect(element.style.display).toBe("block");
  });

  it("keeps the first src and the same node when the caller passes another URL", () => {
    const { container, rerender } = render(<FramePanel src="https://frame.test/first" title="Live page" />);
    const element = frame(container);

    rerender(<FramePanel src="https://frame.test/second" title="Live page" />);
    rerender(<FramePanel src="https://frame.test/third" title="Renamed" />);

    expect(frame(container)).toBe(element);
    expect(element.getAttribute("src")).toBe("https://frame.test/first");
    expect(element.getAttribute("title")).toBe("Renamed");
  });

  it("passes sandbox and allow through and omits them by default", () => {
    const plain = render(<FramePanel src="https://frame.test/a" title="A" />);
    expect(frame(plain.container).hasAttribute("sandbox")).toBe(false);
    expect(frame(plain.container).hasAttribute("allow")).toBe(false);
    plain.unmount();

    const limited = render(
      <FramePanel src="https://frame.test/b" title="B" sandbox="allow-scripts allow-same-origin" allow="microphone; camera" />,
    );
    expect(frame(limited.container).getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame(limited.container).getAttribute("allow")).toBe("microphone; camera");
  });

  it("covers the frame with the loading state until the page loads, without replacing the iframe", () => {
    const onLoad = vi.fn();
    const { container } = render(<FramePanel src="https://frame.test/live" title="Live page" onLoad={onLoad} />);
    const element = frame(container);
    expect(container.querySelector('[data-panel-state="loading"]')).not.toBeNull();

    fireEvent.load(element);

    expect(container.querySelector("[data-panel-state]")).toBeNull();
    expect(frame(container)).toBe(element);
    expect(element.getAttribute("src")).toBe("https://frame.test/live");
    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});
