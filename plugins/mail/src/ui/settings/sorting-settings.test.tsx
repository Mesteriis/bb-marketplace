// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_SETTING_DEFAULTS } from "../../core/page-settings.ts";
import type { PageSettingsPort } from "./setting-controls.tsx";
import { SortingSettings, type AiLabelPorts, type AiLabelView } from "./sorting-settings.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const PITCH: AiLabelView = { id: "l1", name: "Pitch", description: "Cold sales offers.", autoArchive: true };
const INVOICE: AiLabelView = { id: "l2", name: "Invoice", description: "Bills to pay.", autoArchive: false };

function mount(stored: AiLabelView[], overrides: Partial<AiLabelPorts> = {}) {
  const save = vi.fn(async () => ({ ok: true as const }));
  const port: PageSettingsPort = { values: { ...PAGE_SETTING_DEFAULTS }, save };
  const ports = {
    list: vi.fn(async () => stored),
    save: vi.fn(async (input: { id?: string; name: string; description: string; autoArchive: boolean }) => ({ id: input.id ?? "new-1", ...input })),
    remove: vi.fn(async () => {}),
    move: vi.fn(async () => [INVOICE, PITCH]),
    ...overrides,
  };
  render(<SortingSettings port={port} labels={ports} />);
  return { ports, save };
}

describe("SortingSettings", () => {
  it("the switch saves aiSort; without labels it says what a label is", async () => {
    const { save } = mount([]);
    await screen.findByText("No AI labels yet. A label is a name and, in your own words, what belongs under it.");
    const toggle = screen.getByRole("switch", { name: "Sort new mail with AI" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(save).toHaveBeenLastCalledWith({ aiSort: true });
  });

  it("lists the labels with what they mean and which archive; adds one", async () => {
    const { ports } = mount([PITCH]);
    const listed = await screen.findByRole("list", { name: "AI labels" });
    expect(listed.textContent).toContain("Pitch");
    expect(listed.textContent).toContain("archives automatically");
    expect(listed.textContent).toContain("Cold sales offers.");
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    const submit = screen.getByRole("button", { name: "Save label" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Label name"), { target: { value: "Invoice" } });
    fireEvent.change(screen.getByLabelText("What belongs under it"), { target: { value: "Bills to pay." } });
    fireEvent.click(submit);
    await waitFor(() => expect(ports.save).toHaveBeenCalledWith({ name: "Invoice", description: "Bills to pay.", autoArchive: false }));
    await waitFor(() => expect(screen.getByRole("list", { name: "AI labels" }).textContent).toContain("Bills to pay."));
    expect(screen.queryByLabelText("Label name")).toBeNull();
  });

  it("edits a label with its id, turning the automatic archive off", async () => {
    const { ports } = mount([PITCH]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit: Pitch" }));
    expect((screen.getByLabelText("Label name") as HTMLInputElement).value).toBe("Pitch");
    fireEvent.click(screen.getByRole("switch", { name: "Archive automatically" }));
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    await waitFor(() => expect(ports.save).toHaveBeenCalledWith({ id: "l1", name: "Pitch", description: "Cold sales offers.", autoArchive: false }));
    await waitFor(() => expect(screen.getByRole("list", { name: "AI labels" }).textContent).not.toContain("archives automatically"));
  });

  it("moves and removes; the ends of the list cannot move further", async () => {
    const { ports } = mount([PITCH, INVOICE]);
    await screen.findByRole("list", { name: "AI labels" });
    expect((screen.getByRole("button", { name: "Move up: Pitch" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move down: Invoice" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move down: Pitch" }));
    await waitFor(() => expect(ports.move).toHaveBeenCalledWith("l1", 1));
    await waitFor(() => expect((screen.getByRole("button", { name: "Move up: Invoice" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Remove: Pitch" }));
    await waitFor(() => expect(ports.remove).toHaveBeenCalledWith("l1"));
    await waitFor(() => expect(screen.getByRole("list", { name: "AI labels" }).textContent).not.toContain("Pitch"));
  });

  it("shows the server's refusal and keeps the form", async () => {
    mount([PITCH], {
      save: vi.fn(async () => {
        throw new Error("Another AI label has this name");
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add label" }));
    fireEvent.change(screen.getByLabelText("Label name"), { target: { value: "pitch" } });
    fireEvent.change(screen.getByLabelText("What belongs under it"), { target: { value: "Again." } });
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Another AI label has this name");
    expect(screen.getByLabelText("Label name")).toBeTruthy();
  });

  it("a form being edited is not replaced by another label's: Edit and Add wait for Save or Cancel", async () => {
    mount([PITCH, INVOICE]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit: Pitch" }));
    fireEvent.change(screen.getByLabelText("Label name"), { target: { value: "Pitches I typed" } });
    expect(screen.getByRole("button", { name: "Edit: Invoice" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit: Invoice" }));
    expect((screen.getByLabelText("Label name") as HTMLInputElement).value).toBe("Pitches I typed");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Edit: Invoice" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Edit: Invoice" }));
    expect((screen.getByLabelText("Label name") as HTMLInputElement).value).toBe("Invoice");
  });
});
