// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleView } from "../core/contract.ts";
import { RulesSettings } from "./rules-settings.tsx";
import { fakeCall } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const RULE: RuleView = {
  id: "r-1",
  name: "CI failures",
  enabled: true,
  match: { dev: { source: "github", state: "failed" } },
  projectId: "p-api",
  projectName: "api",
  template: "Look",
  mode: "prepare",
  createdAt: "2026-11-16T08:00:00.000Z",
  updatedAt: "2026-11-16T08:00:00.000Z",
};

describe("RulesSettings", () => {
  it("off: only the switch shows and no rule is read", () => {
    const fake = fakeCall();
    render(<RulesSettings on={false} call={fake.call} notify={vi.fn()} hint="Change it in BB." />);
    expect(screen.getByText("Off: no rule runs.")).toBeTruthy();
    expect(fake.to("rules_list")).toHaveLength(0);
  });

  it("lists rules, deletes one, and Pause all offers Undo", async () => {
    let enabled = true;
    const fake = fakeCall({
      rules_list: () => ({ rules: [{ ...RULE, enabled }] }),
      rules_pause: (input) => {
        enabled = input.undo === true;
        return { paused: 1 };
      },
      rule_delete: () => ({ ok: true }),
    });
    const notify = vi.fn();
    render(<RulesSettings on call={fake.call} notify={notify} hint="Change it in BB." />);
    const row = within(await screen.findByRole("list", { name: "Mail rules" })).getByRole("listitem");
    expect(row.textContent).toContain("Prepares in api");
    fireEvent.click(screen.getByRole("button", { name: "Pause all" }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0]![0]).toBe("Paused 1 rule");
    await screen.findByText("Off");
    notify.mock.calls[0]![1].run();
    await waitFor(() => expect(fake.to("rules_pause").at(-1)).toEqual({ undo: true }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(fake.to("rule_delete")).toEqual([{ id: "r-1" }]));
  });
});
