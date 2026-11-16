// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleRunView } from "../core/contract.ts";
import { RuleStrip } from "./rule-strip.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const run = (id: string, state: RuleRunView["state"], ruleName: string | null = "CI failures"): RuleRunView => ({
  id,
  ruleId: "r-1",
  ruleName,
  accountId: "acc-1",
  messageId: `m-${id}`,
  threadId: "th-1",
  state,
  bbThreadId: null,
  subject: `Run failed ${id}`,
  createdAt: "2026-11-16T08:00:00.000Z",
});

describe("RuleStrip", () => {
  it("lists ready, capped and failed runs with Review, Dismiss and Pause all", () => {
    const props = { onReview: vi.fn(), onDismiss: vi.fn(), onPauseAll: vi.fn() };
    render(<RuleStrip runs={[run("1", "ready"), run("2", "capped"), run("3", "failed", null)]} {...props} />);
    const strip = screen.getByRole("region", { name: "Ready to start" });
    expect(within(strip).getByText("Ready to start (3)")).toBeTruthy();
    const rows = within(strip).getAllByRole("listitem");
    expect(rows[1]!.textContent).toContain("over the rule's limit");
    expect(rows[2]!.textContent).toContain("A deleted rule");
    expect((within(rows[2]!).getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Review" }));
    expect(props.onReview).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Dismiss" }));
    expect(props.onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
    fireEvent.click(within(strip).getByRole("button", { name: "Pause all rules" }));
    expect(props.onPauseAll).toHaveBeenCalled();
  });

  it("shows nothing without runs", () => {
    render(<RuleStrip runs={[]} onReview={vi.fn()} onDismiss={vi.fn()} onPauseAll={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Ready to start" })).toBeNull();
  });
});
