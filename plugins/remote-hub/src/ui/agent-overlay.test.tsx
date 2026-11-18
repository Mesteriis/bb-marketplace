// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentContextProvider } from "./agent-context.tsx";
import { AgentOverlay, AgentStage } from "./agent-overlay.tsx";
import { HUMAN_CONTROL, type ControlView } from "./control-banner.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const AGENT: ControlView = { owner: "agent", expiresAt: 1_700_000_000_000, blocked: false };
const HANDLE = { generation: "a".repeat(32), sessionId: 4 };

function reduceMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: on && query.includes("prefers-reduced-motion"), addEventListener() {}, removeEventListener() {} }));
}

describe("AgentOverlay", () => {
  it("appears only for an agent lease, never while a human drives", () => {
    const { container, rerender } = render(<AgentOverlay control={HUMAN_CONTROL} onTakeover={async () => {}} />);
    expect(container.textContent).toBe("");
    rerender(<AgentOverlay control={AGENT} onTakeover={async () => {}} />);
    expect(screen.getByTestId("agent-overlay")).toBeTruthy();
    rerender(<AgentOverlay control={HUMAN_CONTROL} onTakeover={async () => {}} />);
    expect(screen.queryByTestId("agent-overlay")).toBeNull();
  });

  it("names itself for assistive technology: a group, a polite live label and a button called Take control", () => {
    render(<AgentOverlay control={AGENT} onTakeover={async () => {}} threadTitle="Fix the deploy" />);
    expect(screen.getByRole("group", { name: "Agent control" })).toBeTruthy();
    const label = screen.getByRole("status");
    expect(label.getAttribute("aria-live")).toBe("polite");
    expect(label.textContent).toBe("Agent is controlling this session — Fix the deploy");
    expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
    // The dots are only a picture.
    expect(document.querySelector(".rh-agent-dots")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("without a known thread title it says only what it knows", () => {
    render(<AgentOverlay control={AGENT} onTakeover={async () => {}} />);
    expect(screen.getByRole("status").textContent).toBe("Agent is controlling this session");
  });

  it("Take control calls the owner path once, is off while it runs, and shows a failure", async () => {
    let fail!: (e: Error) => void;
    const onTakeover = vi.fn(() => new Promise<void>((_ok, no) => (fail = no)));
    render(<AgentOverlay control={AGENT} onTakeover={onTakeover} />);
    const button = screen.getByRole("button", { name: "Take control" }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    fail(new Error("not_found: nope"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not take control"));
    expect(button.disabled).toBe(false);
  });

  it("Escape does not take control; a click on the label does not either; only the button does", () => {
    const onTakeover = vi.fn(async () => {});
    render(<AgentOverlay control={AGENT} onTakeover={onTakeover} />);
    fireEvent.keyDown(screen.getByRole("group", { name: "Agent control" }), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("status"));
    expect(onTakeover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it("after a blocked key it says the input was not sent", () => {
    render(<AgentOverlay control={{ ...AGENT, blocked: true }} onTakeover={async () => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("Your input was not sent");
  });

  it("carries the reduced-motion class when the system asks for it, and not otherwise", () => {
    reduceMotion(true);
    const { unmount } = render(<AgentOverlay control={AGENT} onTakeover={async () => {}} />);
    expect(screen.getByTestId("agent-overlay").className).toContain("rh-reduced-motion");
    unmount();
    reduceMotion(false);
    render(<AgentOverlay control={AGENT} onTakeover={async () => {}} />);
    expect(screen.getByTestId("agent-overlay").className).not.toContain("rh-reduced-motion");
  });
});

describe("AgentStage", () => {
  const ctx = (thread: string | null) => ({ leaseThread: vi.fn(async () => thread), renderThreadTitle: (id: string) => `title of ${id}` });

  it("lays the overlay over the widget without touching the widget, and asks the service record for the thread", async () => {
    const value = ctx("thr_a");
    render(
      <AgentContextProvider value={value}>
        <AgentStage handle={HANDLE} control={AGENT} onTakeover={async () => {}}>
          <div data-testid="widget">terminal</div>
        </AgentStage>
      </AgentContextProvider>,
    );
    expect(screen.getByTestId("widget").parentElement?.className).toContain("rh-agent-stage");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("title of thr_a"));
    expect(value.leaseThread).toHaveBeenCalledWith(HANDLE);
  });

  it("no overlay and no lookup while the human drives; the widget is still there", () => {
    const value = ctx("thr_a");
    render(
      <AgentContextProvider value={value}>
        <AgentStage handle={HANDLE} control={HUMAN_CONTROL} onTakeover={async () => {}}>
          <div data-testid="widget">terminal</div>
        </AgentStage>
      </AgentContextProvider>,
    );
    expect(screen.getByTestId("widget")).toBeTruthy();
    expect(screen.queryByTestId("agent-overlay")).toBeNull();
    expect(value.leaseThread).not.toHaveBeenCalled();
  });

  it("works without a provider (no title)", () => {
    render(
      <AgentStage handle={HANDLE} control={AGENT} onTakeover={async () => {}}>
        <div>terminal</div>
      </AgentStage>,
    );
    expect(screen.getByRole("status").textContent).toBe("Agent is controlling this session");
  });
});
