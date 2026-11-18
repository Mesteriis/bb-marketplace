// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBanner, type AgentBannerApi, bannerRows } from "./agent-banner.tsx";
import type { AgentSessionView } from "./agent-panel.tsx";

afterEach(cleanup);
const GEN = "a".repeat(32);
const row = (over: Partial<AgentSessionView>): AgentSessionView =>
  ({
    generation: GEN, sessionId: 1, kind: "ssh", connectionId: "c1", state: "running", openedByThread: null, openedByArchivedThread: false, holdUntil: null,
    controlledBy: "human", leaseThreadId: null, leaseExpiresAt: null, questions: [], certificate: null, watching: false, watchingRequired: true, ...over,
  }) as AgentSessionView;

describe("bannerRows: which sessions the owner must be told about", () => {
  it("an agent that holds a session, or opened one that is still open; nothing else", () => {
    const rows = bannerRows([
      row({ sessionId: 1, controlledBy: "agent", leaseThreadId: "thr_a" }),
      row({ sessionId: 2, openedByThread: "thr_b" }),
      row({ sessionId: 3, openedByThread: "thr_b", state: "closed" }),
      row({ sessionId: 4 }),
    ]);
    expect(rows.map((r) => r.sessionId)).toEqual([1, 2]);
  });
});

function api(rows: AgentSessionView[], over: Partial<AgentBannerApi> = {}) {
  const listeners: Array<() => void> = [];
  const value: AgentBannerApi & { fire: () => void } = {
    sessions: vi.fn(async () => rows),
    takeover: vi.fn(async () => ({ tookOver: true })),
    watch: vi.fn(),
    watchInSplit: vi.fn(async () => ({ result: "split" as const })),
    openThread: vi.fn(),
    subscribe: (cb) => {
      listeners.push(cb);
      return () => void listeners.splice(listeners.indexOf(cb), 1);
    },
    fire: () => listeners.forEach((l) => l()),
    ...over,
  };
  return value;
}

describe("AgentBanner", () => {
  it("shows nothing while no agent is active", async () => {
    const a = api([row({})]);
    const { container } = render(<AgentBanner api={a} />);
    await waitFor(() => expect(a.sessions).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("an agent driving a session nobody watches says it is paused and offers Watch and Take control", async () => {
    const a = api([row({ controlledBy: "agent", leaseThreadId: "thr_a", watching: false })]);
    render(<AgentBanner api={a} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("paused"));
    expect(screen.getByRole("status").textContent).toContain("nobody is watching");
    fireEvent.click(screen.getByRole("button", { name: "Watch" }));
    expect(a.watch).toHaveBeenCalledWith(`${GEN}.1`);
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(a.takeover).toHaveBeenCalledWith({ generation: GEN, sessionId: 1 }));
  });

  it("Watch in split passes the thread that holds the session; a refused split shows a way to the thread", async () => {
    const a = api([row({ controlledBy: "agent", leaseThreadId: "thr_lease", openedByThread: "thr_open" })], { watchInSplit: vi.fn(async () => ({ result: "fallback" as const })) });
    render(<AgentBanner api={a} />);
    await waitFor(() => screen.getByRole("button", { name: "Watch in split" }));
    fireEvent.click(screen.getByRole("button", { name: "Watch in split" }));
    await waitFor(() => expect(a.watchInSplit).toHaveBeenCalledWith(`${GEN}.1`, "thr_lease"));
    fireEvent.click(await screen.findByRole("button", { name: /Splits are off here/ }));
    expect(a.openThread).toHaveBeenCalledWith("thr_lease");
  });

  it("with the owner's rule OFF an unwatched agent is announced as acting anyway, not as paused", async () => {
    const a = api([row({ controlledBy: "agent", leaseThreadId: "thr_a", watching: false, watchingRequired: false }), row({ sessionId: 2, openedByThread: "thr_b", watching: false, watchingRequired: false })]);
    render(<AgentBanner api={a} />);
    await waitFor(() => expect(screen.getAllByRole("status")).toHaveLength(2));
    const text = screen.getAllByRole("status").map((r) => r.textContent).join(" | ");
    expect(text).toContain("Nobody is watching, and your setting lets it act anyway");
    expect(text).not.toContain("paused");
    expect(text).not.toContain("cannot act until you watch");
  });

  it("while someone watches it says so and the pause note is gone", async () => {
    const a = api([row({ controlledBy: "agent", leaseThreadId: "thr_a", watching: true })]);
    render(<AgentBanner api={a} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("You are watching"));
    expect(screen.getByRole("status").textContent).not.toContain("paused");
  });

  it("an agent that only opened a session is announced without a Take control button", async () => {
    const a = api([row({ openedByThread: "thr_b" })]);
    render(<AgentBanner api={a} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("opened"));
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  });

  it("refreshes when a signal arrives, without reading anything from it", async () => {
    let rows: AgentSessionView[] = [];
    const a = api([], { sessions: vi.fn(async () => rows) });
    render(<AgentBanner api={a} />);
    await waitFor(() => expect(a.sessions).toHaveBeenCalledTimes(1));
    rows = [row({ controlledBy: "agent", leaseThreadId: "thr_a" })];
    act(() => a.fire());
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
  });

  it("a failing read leaves the banner as it was and shows no error text from the server", async () => {
    const a = api([], { sessions: vi.fn(async () => { throw new Error("secret detail"); }) });
    const { container } = render(<AgentBanner api={a} />);
    await waitFor(() => expect(a.sessions).toHaveBeenCalled());
    expect(container.textContent).not.toContain("secret detail");
  });
});
