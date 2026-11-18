// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./ssh-terminal.tsx", () => ({
  SshTerminal: (p: { token: string; onControl?: (m: unknown) => void; onAgent?: (e: unknown) => void }) => {
    (globalThis as unknown as { __term: typeof p }).__term = p;
    return <div data-testid="terminal" data-token={p.token} />;
  },
}));
vi.mock("./rdp-canvas.tsx", () => ({
  RdpCanvas: (p: { token: string }) => <div data-testid="desktop" data-token={p.token} />,
}));

import { LiveSession, parseSessionKey, type LiveSessionApi } from "./live-session.tsx";

afterEach(cleanup);
const GEN = "a".repeat(32);
const KEY = `${GEN}.4`;

function api(kind: "ssh" | "rdp" | "none", over: Partial<LiveSessionApi> = {}): LiveSessionApi {
  let n = 0;
  return {
    find: vi.fn(async () => (kind === "none" ? null : { generation: GEN, sessionId: 4, kind, state: "running" as const })),
    attach: vi.fn(async () => ({ token: "tok" + ++n, wsUrl: "ws://x/attach" })),
    takeover: vi.fn(async () => {}),
    ...over,
  };
}

describe("parseSessionKey: the id in a message directive is untrusted text", () => {
  it("accepts only generation.number and refuses anything else", () => {
    expect(parseSessionKey(KEY)).toEqual({ generation: GEN, sessionId: 4 });
    for (const bad of ["", "x", `${GEN}.`, `${GEN}.-1`, `${GEN}.1e3`, "../../etc", `${GEN}.4 ; rm`, `${"a".repeat(31)}.4`, undefined, `${GEN}.99999999999`]) {
      expect(parseSessionKey(bad as string), String(bad)).toBeNull();
    }
  });
});

describe("LiveSession", () => {
  it("shows a terminal for an SSH session, with who drives and a way to take control", async () => {
    const a = api("ssh");
    render(<LiveSession sessionKey={KEY} api={a} />);
    await waitFor(() => expect(screen.getByTestId("terminal").getAttribute("data-token")).toBe("tok1"));
    expect(a.attach).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 });
    act(() => (globalThis as unknown as { __term: { onControl: (m: unknown) => void } }).__term.onControl({ type: "control", owner: "agent", expiresAt: 1_700_000_000_000 }));
    expect(screen.getByTestId("control-owner").textContent).toContain("driven by an agent");
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(a.takeover).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }));
  });

  it("shows the desktop for an RDP session", async () => {
    render(<LiveSession sessionKey={KEY} api={api("rdp")} />);
    await waitFor(() => expect(screen.getByTestId("desktop")).toBeTruthy());
    expect(screen.queryByTestId("terminal")).toBeNull();
  });

  it("says plainly when the session is gone, and when the id is not a session id at all", async () => {
    const { unmount } = render(<LiveSession sessionKey={KEY} api={api("none")} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("no longer open"));
    unmount();
    const a = api("ssh");
    render(<LiveSession sessionKey="not-a-session" api={a} />);
    expect(screen.getByRole("alert").textContent).toContain("not a session");
    expect(a.find).not.toHaveBeenCalled();
  });

  it("an attach failure is shown, not thrown", async () => {
    render(<LiveSession sessionKey={KEY} api={api("ssh", { attach: vi.fn(async () => { throw new Error("session_not_found: gone"); }) })} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not show"));
  });
});
