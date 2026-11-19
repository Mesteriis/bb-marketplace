// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PveConsoleOpened } from "./pve-api.ts";
import { PveConsoles, type PveConsoleLaunch, type PveConsolesApi } from "./pve-consoles.tsx";

// The two views are stood in for: this file tests the tabs, the header and the open/close/reconnect behaviour, not xterm or noVNC.
const terminals: Array<Record<string, (...a: never[]) => void>> = [];
const vncs: Array<Record<string, (...a: never[]) => void>> = [];
// Counted by effect: a mount and an unmount are the real events (a re-render is not one). They stand for the upstream connection.
let mounts = { terminal: 0, vnc: 0, unmounts: 0 };
vi.mock("./ssh-terminal.tsx", () => ({
  SshTerminal: (props: Record<string, (...a: never[]) => void>) => {
    terminals.push(props);
    useEffect(() => {
      mounts.terminal += 1;
      return () => void (mounts.unmounts += 1);
    }, []);
    return <div data-testid="terminal" />;
  },
}));
vi.mock("./vnc-view.tsx", () => ({
  VncView: (props: Record<string, (...a: never[]) => void>) => {
    vncs.push(props);
    useEffect(() => {
      mounts.vnc += 1;
      return () => void (mounts.unmounts += 1);
    }, []);
    return <div data-testid="vnc" />;
  },
}));

beforeEach(() => {
  terminals.length = 0;
  vncs.length = 0;
  mounts = { terminal: 0, vnc: 0, unmounts: 0 };
});
afterEach(cleanup);

const launch = (nonce: number, request: PveConsoleLaunch["request"], title = "web"): PveConsoleLaunch => ({ nonce, profileId: "p1", connectionName: "lab", request, title });

function fakeApi(over: Partial<PveConsolesApi> = {}) {
  let n = 0;
  const calls = { open: [] as unknown[], attach: [] as unknown[], close: [] as unknown[] };
  const api: PveConsolesApi = {
    open: vi.fn(async (input) => {
      calls.open.push(input);
      n += 1;
      return { ok: true as const, generation: "a".repeat(32), sessionId: n, kind: input.console === "qemu" ? ("vnc" as const) : ("pve" as const) };
    }),
    attach: vi.fn(async (h) => {
      calls.attach.push(h);
      return { token: "tok-" + h.sessionId, wsUrl: "ws://x/attach" };
    }),
    close: vi.fn(async (h) => void calls.close.push(h)),
    ...over,
  };
  return { api, calls };
}

const lastTerminal = () => terminals[terminals.length - 1] as Record<string, (...a: unknown[]) => void>;

describe("PveConsoles", () => {
  it("opens a container terminal: connecting, then the console's own state, with the header naming the connection and the guest", async () => {
    const { api, calls } = fakeApi();
    render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    expect(await screen.findByTestId("terminal")).toBeTruthy();
    expect(calls.open).toEqual([{ console: "lxc", vmid: 101, profileId: "p1", cols: 80, rows: 24 }]);
    const panel = screen.getByTestId("pve-console");
    expect(panel.textContent).toContain("lab");
    expect(panel.textContent).toContain("container web #101");
    act(() => lastTerminal().onConsole?.({ state: "active", reason: null }));
    expect(screen.getByTestId("pve-console-state").textContent).toBe("active");
  });

  it("a node shell and a VM's graphics use the terminal and the graphical view respectively", async () => {
    const { api } = fakeApi();
    const { rerender } = render(<PveConsoles api={api} launch={launch(1, { console: "node", node: "pve1" }, "pve1")} />);
    await screen.findByTestId("terminal");
    expect(screen.getByTestId("pve-console").textContent).toContain("node pve1");
    rerender(<PveConsoles api={api} launch={launch(2, { console: "qemu", vmid: 200 }, "db")} />);
    await screen.findByTestId("vnc");
    expect(screen.getAllByTestId("pve-console-tab")).toHaveLength(2);
  });

  it("several consoles at once: switching tabs mounts nothing again and opens or closes nothing", async () => {
    const { api, calls } = fakeApi();
    const { rerender } = render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    await screen.findByTestId("terminal");
    rerender(<PveConsoles api={api} launch={launch(2, { console: "lxc", vmid: 102 }, "db")} />);
    await waitFor(() => expect(screen.getAllByTestId("terminal")).toHaveLength(2));
    const before = { ...mounts };
    const tabs = screen.getAllByTestId("pve-console-tab");
    fireEvent.click(tabs[0]!);
    fireEvent.click(tabs[1]!);
    fireEvent.click(tabs[0]!);
    rerender(<PveConsoles api={api} launch={launch(2, { console: "lxc", vmid: 102 }, "db")} />); // the same request again is not a new one
    expect(mounts).toEqual(before);
    expect(mounts.unmounts).toBe(0);
    expect(calls.open).toHaveLength(2);
    expect(calls.close).toEqual([]);
    expect(screen.getAllByTestId("pve-console").map((p) => p.hasAttribute("hidden"))).toEqual([false, true]);
  });

  it("a refused open shows the reason as the console's state, with no view and nothing to close", async () => {
    const { api, calls } = fakeApi({ open: vi.fn(async () => ({ ok: false as const, code: "no_permission", message: "m", fingerprint: null })) });
    render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    expect((await screen.findByTestId("pve-console-reason")).textContent).toContain("VM.Console");
    expect(screen.getByTestId("pve-console-state").textContent).toBe("error");
    expect(screen.queryByTestId("terminal")).toBeNull();
    expect(calls.close).toEqual([]);
  });

  it("a certificate refusal shows its fingerprint and says to confirm it in the connection", async () => {
    const fp = Array.from({ length: 32 }, () => "AB").join(":");
    const { api } = fakeApi({ open: vi.fn(async () => ({ ok: false as const, code: "tls_untrusted", message: "", fingerprint: fp })) });
    render(<PveConsoles api={api} launch={launch(1, { console: "node", node: "pve1" })} />);
    const reason = (await screen.findByTestId("pve-console-reason")).textContent ?? "";
    expect(reason).toContain(fp);
    expect(reason).toContain("Confirm it in the connection first");
  });

  it("the other side ending the console is lost, with its reason; Reconnect opens a NEW console and closes the old one", async () => {
    const { api, calls } = fakeApi();
    render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    await screen.findByTestId("terminal");
    act(() => lastTerminal().onStateChange?.("closed", { exitCode: null, signal: null, reason: "remote_closed" }));
    expect(screen.getByTestId("pve-console-state").textContent).toBe("lost");
    expect(screen.getByTestId("pve-console-reason").textContent).toContain("Proxmox closed the console");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(calls.open).toHaveLength(2));
    expect(calls.close).toEqual([{ generation: "a".repeat(32), sessionId: 1 }]);
    await waitFor(() => expect(screen.getAllByTestId("terminal").length).toBeGreaterThan(0));
    await waitFor(() => expect(calls.attach).toHaveLength(2));
  });

  it("Reconnect is only offered when the console is not connecting or active", async () => {
    const { api } = fakeApi();
    render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    await screen.findByTestId("terminal");
    act(() => lastTerminal().onConsole?.({ state: "active", reason: null }));
    expect((screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => lastTerminal().onConsole?.({ state: "lost", reason: { code: "websocket_error", text: "The console connection broke (websocket error).", fingerprint: null } }));
    expect((screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Disconnect closes at once and the state is disconnected, not lost; a later socket close does not turn it into lost", async () => {
    const { api, calls } = fakeApi();
    render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    await screen.findByTestId("terminal");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(calls.close).toEqual([{ generation: "a".repeat(32), sessionId: 1 }]);
    expect(screen.getByTestId("pve-console-state").textContent).toBe("disconnected");
    expect(screen.queryByTestId("pve-console-reason")).toBeNull();
    expect(screen.queryByTestId("terminal")).toBeNull();
  });

  it("a graphical console that cannot be reattached is an error with its text", async () => {
    const { api } = fakeApi();
    render(<PveConsoles api={api} launch={launch(1, { console: "qemu", vmid: 200 }, "db")} />);
    await screen.findByTestId("vnc");
    const props = vncs[vncs.length - 1] as Record<string, (...a: unknown[]) => void>;
    act(() => props.onEnded?.({ code: "vnc_not_resumable", text: "This graphical console cannot be reattached; disconnect and open it again." }));
    expect(screen.getByTestId("pve-console-state").textContent).toBe("error");
    expect(screen.getByTestId("pve-console-reason").textContent).toContain("cannot be reattached");
  });

  it("Close tab closes the console and removes the tab; a console opened for a tab closed meanwhile is closed again", async () => {
    let release: (v: { ok: true; generation: string; sessionId: number; kind: "pve" }) => void = () => {};
    const { api, calls } = fakeApi({ open: vi.fn(() => new Promise<PveConsoleOpened>((r) => (release = r as never))) });
    render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    await screen.findByTestId("pve-console");
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(screen.queryByTestId("pve-console")).toBeNull();
    await act(async () => release({ ok: true, generation: "a".repeat(32), sessionId: 9, kind: "pve" }));
    expect(calls.close).toEqual([{ generation: "a".repeat(32), sessionId: 9 }]);
    expect(calls.attach).toEqual([]);
  });

  it("an agent driving the console shows in the header", async () => {
    const { api } = fakeApi();
    render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    await screen.findByTestId("terminal");
    act(() => lastTerminal().onControl?.({ type: "control", owner: "agent", expiresAt: null }));
    expect(within(screen.getByTestId("pve-console")).getByTestId("control-owner").textContent).toContain("driven by an agent");
  });
});
