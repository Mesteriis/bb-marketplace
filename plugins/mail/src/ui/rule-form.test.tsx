// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleInput } from "../core/contract.ts";
import { ruleInputSchema } from "../core/contract.ts";
import { BB_TEXT } from "./bb-ports.ts";
import { CAPS_LINE, RuleForm, START_MODE_LINE, startConfirmText } from "./rule-form.tsx";
import { PROJECTS } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);
// Radix's checkbox measures itself inside a <form>; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function mount() {
  const onSave = vi.fn(async (_input: RuleInput) => undefined);
  render(<RuleForm rule={null} projects={PROJECTS} onSave={onSave} onCancel={vi.fn()} />);
  return { onSave };
}

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("RuleForm", () => {
  it("refuses a rule without a match, then saves a Prepare rule the server accepts", async () => {
    const { onSave } = mount();
    fill("Name", "CI failures");
    fireEvent.change(screen.getByLabelText("In project"), { target: { value: "p-api" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A rule needs a sender, domain, list, subject words or notification to match");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Notification from"), { target: { value: "github" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "failed" } });
    fill("Repository", "github.com/example-org/demo");
    fill("Instruction for the agent", "Find the failing test; do not push.");
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const input = onSave.mock.calls[0]![0];
    expect(input).toMatchObject({
      name: "CI failures",
      mode: "prepare",
      projectId: "p-api",
      match: { dev: { source: "github", state: "failed", repo: "github.com/example-org/demo" } },
    });
    expect(ruleInputSchema.safeParse(input).success).toBe(true);
    expect(screen.getByText(CAPS_LINE)).toBeTruthy();
  });

  it("Start needs the confirmation that names the project and the worktree line", async () => {
    const { onSave } = mount();
    fill("Name", "Deploys");
    fill("Sender domains", "Example.org");
    fireEvent.change(screen.getByLabelText("In project"), { target: { value: "p-api" } });
    fireEvent.click(screen.getByLabelText("Start the thread by itself"));
    expect(screen.getByText(startConfirmText("api"))).toBeTruthy();
    expect(screen.getByText(START_MODE_LINE)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ mode: "start", confirmedStart: true, match: { domains: ["example.org"] } });
  });

  it("a project without a checkout cannot take a Start rule", () => {
    mount();
    fireEvent.change(screen.getByLabelText("In project"), { target: { value: "p-docs" } });
    expect((screen.getByLabelText("Start the thread by itself") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText(BB_TEXT.no_tree).length).toBeGreaterThan(0);
  });
});
