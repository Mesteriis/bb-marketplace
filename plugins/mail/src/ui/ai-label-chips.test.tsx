// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { AiLabelChips, AiLine } from "./ai-label-chips.tsx";

installTestPluginRuntime();
afterEach(cleanup);

describe("AiLabelChips", () => {
  it("shows two labels and counts the rest; nothing without labels", () => {
    const view = render(<AiLabelChips labels={[]} />);
    expect(view.container.textContent).toBe("");
    view.rerender(<AiLabelChips labels={["Pitch", "Invoice", "Team", "News"]} />);
    const chips = screen.getByLabelText("AI labels");
    expect(chips.textContent).toBe("PitchInvoice+2");
    expect(chips.getAttribute("title")).toBe("Pitch, Invoice, Team, News");
  });
});

describe("AiLine", () => {
  it("shows the line and every label as text; nothing when there is neither", () => {
    const view = render(<AiLine summary={null} labels={[]} />);
    expect(view.container.textContent).toBe("");
    view.rerender(<AiLine summary={'<b>Vendor</b> offers widgets.'} labels={["Pitch", "Invoice", "Team"]} />);
    const line = screen.getByLabelText("AI summary");
    expect(line.textContent).toBe("<b>Vendor</b> offers widgets.PitchInvoiceTeam");
    expect(line.querySelector("b")).toBeNull();
  });
});
