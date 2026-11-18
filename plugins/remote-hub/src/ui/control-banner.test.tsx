// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ControlBadge, HUMAN_CONTROL, nextControl } from "./control-banner.tsx";

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
