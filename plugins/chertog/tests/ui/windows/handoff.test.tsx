import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HandoffControls, IncomingTransfer } from "../../../src/ui/windows/handoff.tsx";

it("sends the full selected document id and requires a reachable target to accept", () => {
  const pick = vi.fn();
  const target = "634b078f51300";
  render(<HandoffControls owner targets={[target]} show busy={false} error={null} onPick={pick} onToggle={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Окно 634b078f" }));
  expect(pick).toHaveBeenCalledWith(target);
  const accept = vi.fn();
  render(<IncomingTransfer title="Тред" enabled={false} problem="" onCancel={() => {}} onAccept={accept} />);
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  expect(accept).not.toHaveBeenCalled();
});
