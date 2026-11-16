// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { categorySchema } from "../core/model.ts";
import { CATEGORIES, CategoryChip, CategoryFilters, RowCategory } from "./category-chips.tsx";

installTestPluginRuntime();
afterEach(cleanup);

describe("categories", () => {
  it("lists the four categories of the core", () => {
    expect(CATEGORIES.map((c) => c.value)).toEqual(categorySchema.options);
  });

  it("a suggestion offers Accept and Always for this sender", () => {
    const props = { onAccept: vi.fn(), onChange: vi.fn(), onAlways: vi.fn() };
    render(<CategoryChip category={null} suggestion="bills" {...props} />);
    expect(screen.getByText("Suggested category:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(props.onAccept).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Always Bills for this sender" }));
    expect(props.onAlways).toHaveBeenCalledWith("bills");
  });

  it("a label has no Accept; no sender address, no rule", () => {
    render(<CategoryChip category="personal" suggestion="bills" onAccept={vi.fn()} onChange={vi.fn()} onAlways={null} />);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: /for this sender/ })).toBeNull();
  });

  it("row chips mark a suggestion apart from a label", () => {
    const { container, rerender } = render(<RowCategory category={null} suggestion="newsletters" />);
    expect(container.textContent).toBe("Newsletters?");
    rerender(<RowCategory category="bills" suggestion={null} />);
    expect(container.textContent).toBe("Bills");
    rerender(<RowCategory category={null} suggestion={null} />);
    expect(container.textContent).toBe("");
  });

  it("filters pick one category at a time", () => {
    const onChange = vi.fn();
    const { rerender } = render(<CategoryFilters value={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Bills" }));
    expect(onChange).toHaveBeenLastCalledWith("bills");
    rerender(<CategoryFilters value="bills" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Bills" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Bills" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
