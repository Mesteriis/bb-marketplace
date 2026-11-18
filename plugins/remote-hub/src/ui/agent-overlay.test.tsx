// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentContextProvider } from "./agent-context.tsx";
import { AgentBar, AgentDots, AgentStage } from "./agent-overlay.tsx";
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

describe("AgentBar", () => {
  it("appears only for an agent lease, never while a human drives", () => {
    const { container, rerender } = render(<AgentBar control={HUMAN_CONTROL} onTakeover={async () => {}} />);
    expect(container.textContent).toBe("");
    rerender(<AgentBar control={AGENT} onTakeover={async () => {}} />);
    expect(screen.getByRole("group", { name: "Agent control" })).toBeTruthy();
    rerender(<AgentBar control={HUMAN_CONTROL} onTakeover={async () => {}} />);
    expect(screen.queryByRole("group", { name: "Agent control" })).toBeNull();
  });

  it("names itself for assistive technology: a group, a polite live label and a button called Take control", () => {
    render(<AgentBar control={AGENT} onTakeover={async () => {}} threadTitle="Fix the deploy" />);
    expect(screen.getByRole("group", { name: "Agent control" })).toBeTruthy();
    const label = screen.getByRole("status");
    expect(label.getAttribute("aria-live")).toBe("polite");
    expect(label.textContent).toBe("Agent is controlling this session — Fix the deploy");
    expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
  });

  it("without a known thread title it says only what it knows", () => {
    render(<AgentBar control={AGENT} onTakeover={async () => {}} />);
    expect(screen.getByRole("status").textContent).toBe("Agent is controlling this session");
  });

  it("Take control calls the owner path once, is off while it runs, and shows a failure", async () => {
    let fail!: (e: Error) => void;
    const onTakeover = vi.fn(() => new Promise<void>((_ok, no) => (fail = no)));
    render(<AgentBar control={AGENT} onTakeover={onTakeover} />);
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
    render(<AgentBar control={AGENT} onTakeover={onTakeover} />);
    fireEvent.keyDown(screen.getByRole("group", { name: "Agent control" }), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("status"));
    expect(onTakeover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it("after a blocked key it says the input was not sent", () => {
    render(<AgentBar control={{ ...AGENT, blocked: true }} onTakeover={async () => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("Your input was not sent");
  });
});

describe("AgentDots", () => {
  const handle = () => ({ destroy: vi.fn() });

  it("starts the particle field once on the host, marks itself live, and destroys it when it goes away", async () => {
    const h = handle();
    const start = vi.fn(async () => h);
    const { unmount } = render(<AgentDots start={start} />);
    await waitFor(() => expect(screen.getByTestId("agent-overlay").className).toContain("rh-dots-live"));
    expect(start).toHaveBeenCalledTimes(1);
    expect((start.mock.calls[0] as unknown as [HTMLElement])[0].getAttribute("aria-hidden")).toBe("true");
    expect(h.destroy).not.toHaveBeenCalled();
    unmount();
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("under reduced motion the library is never started and the class says so", () => {
    reduceMotion(true);
    const start = vi.fn(async () => handle());
    render(<AgentDots start={start} />);
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByTestId("agent-overlay").className).toContain("rh-reduced-motion");
    expect(screen.getByTestId("agent-overlay").className).not.toContain("rh-dots-live");
  });

  it("when the library cannot start the static dots stay (not live)", async () => {
    const start = vi.fn(async () => null);
    render(<AgentDots start={start} />);
    await waitFor(() => expect(start).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.getByTestId("agent-overlay").className).not.toContain("rh-dots-live");
  });

  it("a field that finishes loading after the overlay is gone is destroyed at once (no leaked canvas)", async () => {
    const h = handle();
    let finish!: (v: typeof h) => void;
    const start = vi.fn(() => new Promise<typeof h>((r) => (finish = r)));
    const { unmount } = render(<AgentDots start={start} />);
    unmount();
    finish(h);
    await waitFor(() => expect(h.destroy).toHaveBeenCalledTimes(1));
  });
});

describe("AgentStage", () => {
  const ctx = (thread: string | null) => ({ leaseThread: vi.fn(async () => thread), renderThreadTitle: (id: string) => `title of ${id}` });

  it("puts the bar above the widget and the dots over it, and asks the service record for the thread", async () => {
    const value = ctx("thr_a");
    render(
      <AgentContextProvider value={value}>
        <AgentStage handle={HANDLE} control={AGENT} onTakeover={async () => {}} startDots={async () => null}>
          <div data-testid="widget">terminal</div>
        </AgentStage>
      </AgentContextProvider>,
    );
    const body = screen.getByTestId("widget").parentElement as HTMLElement;
    expect(body.className).toContain("rh-agent-body");
    const stage = body.parentElement as HTMLElement;
    expect(stage.className).toContain("rh-agent-stage");
    expect(stage.firstElementChild?.getAttribute("role")).toBe("group"); // the bar is the row above the widget
    expect(body.querySelector('[data-testid="agent-overlay"]')).not.toBeNull(); // the dots are inside the widget's box
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
    expect(screen.queryByRole("group", { name: "Agent control" })).toBeNull();
    expect(value.leaseThread).not.toHaveBeenCalled();
  });

  it("works without a provider (no title)", () => {
    render(
      <AgentStage handle={HANDLE} control={AGENT} onTakeover={async () => {}} startDots={async () => null}>
        <div>terminal</div>
      </AgentStage>,
    );
    expect(screen.getByRole("status").textContent).toBe("Agent is controlling this session");
  });
});
