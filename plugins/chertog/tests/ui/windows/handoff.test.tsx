import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HandoffNotice, IncomingTransfer } from "../../../src/ui/windows/handoff.tsx";

it("draws nothing for the owner: the handover action lives in the tile menu", () => {
  const { container } = render(<HandoffNotice owner error={null} />);
  expect(container.innerHTML).toBe("");
});

it("tells a window that does not own the thread, and offers to take it back", () => {
  const recover = vi.fn();
  render(<HandoffNotice owner={false} error={null} ownerId="634b078f51300" onRecover={recover} />);
  fireEvent.click(screen.getByRole("button", { name: "Вернуть панель в это окно" }));
  expect(recover).toHaveBeenCalled();
});

it("names the window that has the thread, and shows an error as an alert", () => {
  const view = render(<HandoffNotice owner={false} error={null} ownerId="634b078f51300" />);
  expect(view.container.textContent).toContain("Панель в окне 634b078f");
  view.rerender(<HandoffNotice owner error="Связь потеряна" />);
  expect(screen.getByRole("alert").textContent).toBe("Связь потеряна");
});

it("requires a reachable target to accept", () => {
  const accept = vi.fn();
  render(<IncomingTransfer title="Тред" enabled={false} problem="" onCancel={() => {}} onAccept={accept} />);
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(accept).not.toHaveBeenCalled();
});

it("is a card in BB's theme with theme buttons", () => {
  render(<IncomingTransfer title="Тред" enabled problem="" onCancel={() => {}} onAccept={() => {}} />);
  const card = screen.getByLabelText("Передача панели");
  expect(card.className).toMatch(/\bbg-card\b/);
  expect(card.className).toMatch(/\bborder-border\b/);
  expect(card.className).toMatch(/\brounded-lg\b/);
  expect(screen.getByRole("button", { name: "Принять" }).className).toMatch(/\bbg-foreground\b/);
  expect(screen.getByRole("button", { name: "Отказаться" }).className).toMatch(/\bborder-border\b/);
});
