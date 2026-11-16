 // @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FolderNavigation } from "../src/ui/folder-navigation.tsx";

afterEach(cleanup);

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
  fireEvent.click(screen.getByRole("button", { name: "Collapse folder itq" }));
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
