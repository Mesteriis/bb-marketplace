// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { OpenLine } from "./open-line.tsx";

installTestPluginRuntime();
afterEach(cleanup);

describe("OpenLine", () => {
  it("shows nothing for a message without the image", () => {
    const { container } = render(<OpenLine opens={undefined} />);
    expect(container.textContent).toBe("");
  });

  it("says not opened yet, then how often and when last, with the caveat as its title", () => {
    render(<OpenLine opens={{ count: 0, lastAt: null }} />);
    expect(screen.getByLabelText("Read status").textContent).toBe("Not opened yet");
    cleanup();
    render(<OpenLine opens={{ count: 1, lastAt: "2026-11-20T14:05:00.000Z" }} />);
    expect(screen.getByLabelText("Read status").textContent).toMatch(/^Opened 1 time \u00b7 last .*2026/);
    cleanup();
    render(<OpenLine opens={{ count: 3, lastAt: "2026-11-20T14:05:00.000Z" }} />);
    const line = screen.getByLabelText("Read status");
    expect(line.textContent).toMatch(/^Opened 3 times \u00b7 last /);
    expect(line.getAttribute("title")).toContain("a hint, not a proof");
  });
});
