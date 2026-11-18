// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionView } from "./agent-panel.tsx";
import { SessionCard, type SessionCardApi } from "./session-card.tsx";

afterEach(cleanup);
const GEN = "a".repeat(32);
const KEY = `${GEN}.4`;

function view(over: Partial<AgentSessionView> = {}): AgentSessionView {
  return {
    generation: GEN, sessionId: 4, kind: "ssh", connectionId: null, state: "running", openedByThread: "thr_open", openedByArchivedThread: false,
    holdUntil: null, controlledBy: "human", leaseThreadId: null, leaseExpiresAt: null, questions: [], certificate: null, watching: false, watchingRequired: true,
    ...over,
  };
}
function api(over: Partial<SessionCardApi> = {}): SessionCardApi {
  return {
    describe: vi.fn(async () => view()),
    watchInSplit: vi.fn(async () => ({ result: "split" as const })),
    open: vi.fn(),
    openThread: vi.fn(),
    ...over,
  };
}

describe("SessionCard: the directive in a message is a card, never a live view", () => {
  it("shows what the session is and two buttons, and attaches to nothing by itself", async () => {
    const a = api();
    render(<SessionCard sessionKey={KEY} api={a} />);
    await waitFor(() => expect(screen.getByTestId("session-card")).toBeTruthy());
    expect(screen.getByTestId("session-card").textContent).toContain("terminal");
    expect(screen.getByTestId("session-card").textContent).toContain("agent thread thr_open");
    expect(a.describe).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 });
    expect(a.watchInSplit).not.toHaveBeenCalled();
    expect(a.open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("terminal")).toBeNull();
  });

  it("Watch in split uses the thread the SERVICE says holds or opened the session (the lease first)", async () => {
    const a = api({ describe: vi.fn(async () => view({ leaseThreadId: "thr_lease", controlledBy: "agent" })) });
    render(<SessionCard sessionKey={KEY} api={a} />);
    await waitFor(() => screen.getByRole("button", { name: "Watch in split" }));
    fireEvent.click(screen.getByRole("button", { name: "Watch in split" }));
    await waitFor(() => expect(a.watchInSplit).toHaveBeenCalledWith(KEY, "thr_lease"));
  });

  it("Open live view opens the page; and when splits are off a link to the thread is shown", async () => {
    const a = api({ watchInSplit: vi.fn(async () => ({ result: "fallback" as const })) });
    render(<SessionCard sessionKey={KEY} api={a} />);
    await waitFor(() => screen.getByRole("button", { name: "Open live view" }));
    fireEvent.click(screen.getByRole("button", { name: "Open live view" }));
    expect(a.open).toHaveBeenCalledWith(KEY);
    fireEvent.click(screen.getByRole("button", { name: "Watch in split" }));
    const link = await screen.findByRole("button", { name: "one click away" });
    fireEvent.click(link);
    expect(a.openThread).toHaveBeenCalledWith("thr_open");
  });

  it("refuses an id that is not generation.number, and says so for a closed or unknown session", async () => {
    const a = api();
    const { unmount } = render(<SessionCard sessionKey="../../etc" api={a} />);
    expect(screen.getByRole("alert").textContent).toContain("not a session");
    expect(a.describe).not.toHaveBeenCalled();
    unmount();
    render(<SessionCard sessionKey={KEY} api={api({ describe: vi.fn(async () => null) })} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("no longer open"));
  });
});
