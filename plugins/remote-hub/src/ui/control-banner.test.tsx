// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlBadge, ControlNotice, HUMAN_CONTROL, nextControl } from "./control-banner.tsx";

afterEach(cleanup);

describe("nextControl", () => {
  it("an agent taking the session sets the owner and the time; input_blocked adds the warning; the human getting it back clears both", () => {
    const agent = nextControl(HUMAN_CONTROL, { type: "control", owner: "agent", expiresAt: 1_700_000_000_000 });
    expect(agent).toEqual({ owner: "agent", expiresAt: 1_700_000_000_000, blocked: false });
    const blocked = nextControl(agent, { type: "input_blocked" });
    expect(blocked).toEqual({ owner: "agent", expiresAt: 1_700_000_000_000, blocked: true });
    expect(nextControl(blocked, { type: "control", owner: "agent", expiresAt: 1_700_000_060_000 })).toEqual({ owner: "agent", expiresAt: 1_700_000_060_000, blocked: true });
    expect(nextControl(blocked, { type: "control", owner: "human", expiresAt: null })).toEqual(HUMAN_CONTROL);
  });

  it("input_blocked while the human drives is ignored (a late message)", () => {
    expect(nextControl(HUMAN_CONTROL, { type: "input_blocked" })).toEqual(HUMAN_CONTROL);
  });
});

describe("ControlBadge", () => {
  it("says who drives, plainly", () => {
    const { rerender } = render(<ControlBadge control={HUMAN_CONTROL} />);
    expect(screen.getByTestId("control-owner").textContent).toBe("driven by you");
    rerender(<ControlBadge control={{ owner: "agent", expiresAt: 1_700_000_000_000, blocked: false }} />);
    expect(screen.getByTestId("control-owner").textContent).toContain("driven by an agent");
  });
});

describe("ControlNotice", () => {
  it("shows nothing while the human drives", () => {
    const { container } = render(<ControlNotice control={HUMAN_CONTROL} onTakeover={async () => {}} />);
    expect(container.textContent).toBe("");
  });

  it("while an agent drives it says the input is paused and offers one button to take control", async () => {
    const onTakeover = vi.fn(async () => {});
    render(<ControlNotice control={{ owner: "agent", expiresAt: 1, blocked: false }} onTakeover={onTakeover} />);
    expect(screen.getByRole("status").textContent).toContain("An agent is driving this session");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(onTakeover).toHaveBeenCalledTimes(1));
  });

  it("after the first blocked key it becomes an alert that says the input was not sent", () => {
    render(<ControlNotice control={{ owner: "agent", expiresAt: 1, blocked: true }} onTakeover={async () => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("Your input was not sent");
    expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
  });

  it("the button is off while the request is in flight, and a failure is shown", async () => {
    let fail!: (e: Error) => void;
    const onTakeover = vi.fn(() => new Promise<void>((_ok, no) => (fail = no)));
    render(<ControlNotice control={{ owner: "agent", expiresAt: 1, blocked: false }} onTakeover={onTakeover} />);
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect((screen.getByRole("button", { name: "Take control" }) as HTMLButtonElement).disabled).toBe(true);
    fail(new Error("not_found: nope"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not take control"));
    expect((screen.getByRole("button", { name: "Take control" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
