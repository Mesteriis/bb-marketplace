 // @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FolderNavigation } from "../src/ui/folder-navigation.tsx";
import { FolderSettings } from "../src/ui/folder-settings.tsx";

afterEach(cleanup);

test("creates a nested Telegram folder and moves it to the top level by renaming it", async () => {
  const load = vi.fn().mockResolvedValueOnce({ title: "IT.Dev", rules: [], shareable: false, revision: "a".repeat(64) })
    .mockResolvedValueOnce({ title: "Dev", rules: [], shareable: false, revision: "b".repeat(64) });
  const save = vi.fn().mockResolvedValueOnce({ id: 9, title: "IT.Dev" }).mockResolvedValueOnce({ id: 9, title: "Dev" });
  const { container } = render(<FolderSettings folders={[{ id: 7, title: "IT" }, { id: 8, title: "LongParent" }]}
    actions={{ limit: async () => 10, load, save, remove: vi.fn(), memberships: vi.fn(), setMembership: vi.fn() }} />);
  const element = container.querySelector("dialog")!;
  element.showModal = () => { element.open = true; };
  fireEvent.click(screen.getByRole("button", { name: "Manage folders" }));
  const editor = within(screen.getByRole("dialog", { name: "Manage folders" }));
  const name = editor.getByRole<HTMLInputElement>("textbox", { name: "Name" });
  const parent = editor.getByRole("combobox", { name: "Parent folder" });
  fireEvent.change(name, { target: { value: "Dev" } });
  fireEvent.change(parent, { target: { value: "LongParent" } });
  expect(editor.getByRole("alert").textContent).toContain("12 characters");
  expect(editor.getByRole("button", { name: "Save folder" })).toHaveProperty("disabled", true);
  fireEvent.change(parent, { target: { value: "IT" } });
  expect(name.value).toBe("IT.Dev");
  fireEvent.click(editor.getByRole("button", { name: "Save folder" }));
  await editor.findByText("Folder saved.");
  expect(save).toHaveBeenNthCalledWith(1, { title: "IT.Dev", rules: [] }, undefined);
  fireEvent.change(parent, { target: { value: "" } });
  expect(name.value).toBe("Dev");
  fireEvent.click(editor.getByRole("button", { name: "Save folder" }));
  await editor.findByText("Folder saved.");
  expect(save).toHaveBeenNthCalledWith(2, { title: "Dev", rules: [] }, 9, "a".repeat(64));
});

test("nests dotted Telegram names while preserving the real folder IDs", () => {
  const select = vi.fn();
  render(<FolderNavigation selected={7} select={select} folders={[
    { id: 7, title: "itq.evoca" }, { id: 8, title: "itq" }, { id: 9, title: "infra.prod.west" },
  ]} />);
  const evoca = screen.getByRole("button", { name: "itq.evoca" });
  expect(evoca.textContent).toBe("evoca");
  expect(evoca.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(evoca);
  fireEvent.click(screen.getByRole("button", { name: /^itq$/ }));
  expect(select.mock.calls).toEqual([[7], [8]]);
  const toggle = screen.getByRole("button", { name: "Collapse folder itq" });
  evoca.focus();
  fireEvent.click(toggle);
  expect(document.activeElement).toBe(toggle);
  expect(evoca.closest("[inert]")?.id).toBe(toggle.getAttribute("aria-controls"));
  expect(screen.queryByRole("button", { name: "itq.evoca" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand folder itq" }));
  expect(screen.getByRole("button", { name: "itq.evoca" }).getAttribute("aria-pressed")).toBe("true");
});

test("groups dotted siblings under a display-only parent when Telegram has no parent folder", () => {
  const select = vi.fn();
  render(<FolderNavigation selected="main" select={select} folders={[
    { id: 7, title: "itq.evoca" }, { id: 8, title: "itq.internal" }, { id: 9, title: "itq..ops" },
  ]} />);
  const parent = screen.getByRole("button", { name: "Collapse folder itq" });
  expect(parent.textContent).toBe("itq");
  expect(screen.queryByRole("button", { name: "itq" })).toBeNull();
  fireEvent.click(parent);
  expect(select).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "itq.evoca" })).toBeNull();
  expect(screen.queryByRole("button", { name: "itq.internal" })).toBeNull();
  expect(screen.getByRole("button", { name: "itq..ops" }).textContent).toBe("itq..ops");
  fireEvent.click(screen.getByRole("button", { name: "Expand folder itq" }));
  fireEvent.click(screen.getByRole("button", { name: "itq.evoca" }));
  fireEvent.click(screen.getByRole("button", { name: "itq.internal" }));
  expect(select.mock.calls).toEqual([[7], [8]]);
});
