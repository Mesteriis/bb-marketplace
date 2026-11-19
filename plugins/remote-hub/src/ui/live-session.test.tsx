// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./ssh-terminal.tsx", () => ({
  SshTerminal: (p: { token: string; onControl?: (m: unknown) => void; onAgent?: (e: unknown) => void }) => {
    (globalThis as unknown as { __term: typeof p }).__term = p;
    return <div data-testid="terminal" data-token={p.token} />;
  },
}));
vi.mock("./vnc-view.tsx", () => ({
  VncView: () => <div data-testid="vnc-view-mounted" />,
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
    expect(screen.getByTestId("control-owner").textContent).toContain("управляет агент");
    fireEvent.click(screen.getByRole("button", { name: "Взять управление" }));
    await waitFor(() => expect(a.takeover).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }));
  });

  it("lists the commands an agent runs, live, from the session's feed", async () => {
    render(<LiveSession sessionKey={KEY} api={api("ssh")} />);
    await waitFor(() => expect(screen.getByTestId("terminal")).toBeTruthy());
    const term = (globalThis as unknown as { __term: { onAgent: (e: unknown) => void } }).__term;
    act(() => term.onAgent({ kind: "exec", commandId: "c1", phase: "started", text: "df -h" }));
    act(() => term.onAgent({ kind: "exec", commandId: "c1", phase: "output", stream: "stdout", text: "Filesystem  Size\n" }));
    expect(screen.getByLabelText("Команды агента").textContent).toContain("$ df -h");
    expect(screen.getByLabelText("Команды агента").textContent).toContain("Filesystem  Size");
    act(() => term.onAgent({ kind: "exec", commandId: "c1", phase: "finished", text: "", exitCode: 0, reason: "exited" }));
    expect(screen.getByLabelText("Команды агента").textContent).toContain("код выхода 0");
  });

  it("shows the desktop for an RDP session", async () => {
    render(<LiveSession sessionKey={KEY} api={api("rdp")} />);
    await waitFor(() => expect(screen.getByTestId("desktop")).toBeTruthy());
    expect(screen.queryByTestId("terminal")).toBeNull();
  });

  it("says plainly when the session is gone, and when the id is не сессия id at all", async () => {
    const { unmount } = render(<LiveSession sessionKey={KEY} api={api("none")} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("уже закрыта"));
    unmount();
    const a = api("ssh");
    render(<LiveSession sessionKey="not-a-session" api={a} />);
    expect(screen.getByRole("alert").textContent).toContain("не сессия");
    expect(a.find).not.toHaveBeenCalled();
  });

  it("an attach failure is shown, not thrown", async () => {
    render(<LiveSession sessionKey={KEY} api={api("ssh", { attach: vi.fn(async () => { throw new Error("session_not_found: gone"); }) })} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Не удалось показать"));
  });

  it("a graphics console is NEVER attached by a card: it shows its state and a way to the Remote Hub page", async () => {
    const openRemoteHub = vi.fn();
    const a = api("ssh", {
      find: vi.fn(async () => ({ generation: GEN, sessionId: 4, kind: "vnc" as const, state: "running" as const, pve: { console: "qemu", node: "pve1", vmid: 200, state: "active", connectionName: "lab" } })),
      openRemoteHub,
    });
    render(<LiveSession sessionKey={KEY} api={a} />);
    const card = await screen.findByTestId("live-session-graphics");
    expect(card.textContent).toContain("Графика VM 200 на «lab», узел pve1: active");
    expect(card.textContent).toContain("здесь она не показывается");
    expect(a.attach).not.toHaveBeenCalled();
    expect(screen.queryByTestId("vnc-view-mounted")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Открыть в Remote Hub" }));
    expect(openRemoteHub).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 });
  });

  it("the graphics card has no button that does nothing when the page cannot open Remote Hub", async () => {
    const a = api("ssh", { find: vi.fn(async () => ({ generation: GEN, sessionId: 4, kind: "vnc" as const, state: "running" as const })) });
    render(<LiveSession sessionKey={KEY} api={a} />);
    expect((await screen.findByRole("button", { name: "Открыть в Remote Hub" })) as HTMLButtonElement).toHaveProperty("disabled", true);
    expect(a.attach).not.toHaveBeenCalled();
  });
});
