// Smoke test of the DOM environment the UI tests run in: React renders into
// jsdom, user events reach handlers, and the two browser APIs jsdom lacks are
// supplied by tests/ui/setup.ts.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

function Toggle() {
  const [pressed, setPressed] = useState(false);
  return (
    <button type="button" onClick={() => setPressed(true)}>
      {pressed ? "Pressed" : "Not pressed"}
    </button>
  );
}

describe("DOM test environment", () => {
  it("renders a React component and a click changes its text", async () => {
    const user = userEvent.setup();
    render(<Toggle />);

    const button = screen.getByRole("button");
    expect(button.textContent).toBe("Not pressed");

    await user.click(button);

    expect(button.textContent).toBe("Pressed");
  });

  it("unmounts the previous test's tree before the next test", () => {
    expect(document.body.childElementCount).toBe(0);
  });

  it("tracks pointer capture per element and pointer", () => {
    const { container } = render(
      <>
        <div data-testid="first" />
        <div data-testid="second" />
      </>,
    );
    const first = container.querySelector('[data-testid="first"]') as HTMLElement;
    const second = container.querySelector('[data-testid="second"]') as HTMLElement;

    expect(first.hasPointerCapture(1)).toBe(false);

    first.setPointerCapture(1);
    expect(first.hasPointerCapture(1)).toBe(true);
    expect(first.hasPointerCapture(2)).toBe(false);
    expect(second.hasPointerCapture(1)).toBe(false);

    // A pointer is captured by one element at a time.
    second.setPointerCapture(1);
    expect(first.hasPointerCapture(1)).toBe(false);
    expect(second.hasPointerCapture(1)).toBe(true);

    second.releasePointerCapture(1);
    expect(second.hasPointerCapture(1)).toBe(false);

    // Releasing a pointer the element does not hold changes nothing.
    first.releasePointerCapture(1);
    expect(first.hasPointerCapture(1)).toBe(false);
  });

  it("drops pointer captures between tests", () => {
    const { container } = render(<div />);
    const element = container.firstElementChild as HTMLElement;
    element.setPointerCapture(7);
    cleanup();
    const again = render(<div />).container.firstElementChild as HTMLElement;
    expect(again.hasPointerCapture(7)).toBe(false);
  });

  it("provides a ResizeObserver that accepts observe, unobserve and disconnect", () => {
    expect(typeof ResizeObserver).toBe("function");

    const calls: number[] = [];
    const observer = new ResizeObserver((entries) => calls.push(entries.length));
    const { container } = render(<div />);
    const element = container.firstElementChild as HTMLElement;

    observer.observe(element);
    observer.unobserve(element);
    observer.disconnect();

    // jsdom has no layout, so the observer never reports a size.
    expect(calls).toEqual([]);
  });
});
