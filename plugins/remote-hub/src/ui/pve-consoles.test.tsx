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
      return { ok: true as const, generation: "a".repeat(32), sessionId: n, kind: input.console === "qemu" ? ("vnc" as const) : ("pve" as const), node: input.console === "node" ? input.node : "pve1" };
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

  it("a console ended for a reason another attempt cannot change is lost, with its reason; Reconnect opens a NEW console and closes the old one", async () => {
    const { api, calls } = fakeApi();
    render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    await screen.findByTestId("terminal");
    act(() => lastTerminal().onStateChange?.("closed", { exitCode: null, signal: null, reason: "login_failed" }));
    expect(screen.getByTestId("pve-console-state").textContent).toBe("lost");
    expect(screen.getByTestId("pve-console-reason").textContent).toContain("enter its password again");
    expect(screen.getByTestId("pve-console-new-console").textContent).toContain("NEW console");
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
    act(() => lastTerminal().onConsole?.({ state: "lost", reason: { code: "no_permission", text: "x", fingerprint: null } }));
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

  it("a graphics socket that closes bare makes the tab lost with Reconnect enabled, and keeps an earlier specific reason", async () => {
    const { api } = fakeApi();
    render(<PveConsoles api={api} launch={launch(1, { console: "qemu", vmid: 200 }, "db")} />);
    await screen.findByTestId("vnc");
    const props = vncs[vncs.length - 1] as Record<string, (...a: unknown[]) => void>;
    act(() => props.onConsole?.({ state: "active", reason: null }));
    act(() => props.onViewState?.("ready")); // a screen was shown: this is a loss, not a failed start
    act(() => props.onEnded?.({ code: "websocket_error", text: "The console connection broke (websocket error)." }));
    expect(screen.getByTestId("pve-console-state").textContent).toBe("lost");
    expect((screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(false);
    // a specific reason that came first is not replaced by the generic one that follows it
    act(() => props.onConsole?.({ state: "lost", reason: { code: "remote_closed", text: "Proxmox closed the console.", fingerprint: null } }));
    act(() => props.onEnded?.({ code: "websocket_error", text: "The console connection broke (websocket error)." }));
    expect(screen.getByTestId("pve-console-reason").textContent).toContain("Proxmox closed the console");
  });

  it("an adopted console (one an agent opened) is attached to, not opened again; Reconnect later opens a new one", async () => {
    const { api, calls } = fakeApi();
    render(<PveConsoles api={api} launch={{ ...launch(1, { console: "qemu", vmid: 200 }, "db"), adopt: { handle: { generation: "c".repeat(32), sessionId: 3 }, kind: "vnc" } }} />);
    await screen.findByTestId("vnc");
    expect(calls.open).toEqual([]);
    expect(calls.attach).toEqual([{ generation: "c".repeat(32), sessionId: 3 }]);
    const props = vncs[vncs.length - 1] as Record<string, (...a: unknown[]) => void>;
    act(() => props.onConsole?.({ state: "lost", reason: { code: "remote_closed", text: "x", fingerprint: null } }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(calls.open).toHaveLength(1));
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


describe("PveConsoles: reconnecting, restoring and moved guests", () => {
  const LOST = { exitCode: null, signal: null, reason: "remote_closed" };
  const sep = (s: string) => expect.stringContaining(s);
  const state = () => screen.getByTestId("pve-console-state").textContent;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: 1, 2, 4, 8, 16 s exactly
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Opens a container console and makes it active, with a terminal API that returns `scrollback`. */
  async function active(api: PveConsolesApi, scrollback = "root@ct:~# ls\r\nfile") {
    const view = render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const first = lastTerminal() as unknown as { apiRef: { current: unknown } };
    const note = vi.fn();
    first.apiRef.current = { text: () => scrollback, note };
    act(() => lastTerminal().onConsole?.({ state: "active", reason: null }));
    return { view, note };
  }
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it("a lost terminal reconnects by itself: waits 1 s, opens a NEW console with a fresh open, keeps the scrollback behind a separator", async () => {
    const { api, calls } = fakeApi();
    const { note } = await active(api);
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    expect(state()).toBe("reconnecting (1 of 5)");
    expect(note).toHaveBeenCalledWith(sep("connection lost"));
    expect(screen.getByTestId("pve-console-reconnecting").textContent).toContain("Nothing typed before the loss is sent again");
    await advance(999);
    expect(calls.open).toHaveLength(1);
    await advance(1);
    expect(calls.open).toHaveLength(2);
    expect(calls.close).toEqual([{ generation: "a".repeat(32), sessionId: 1 }]);
    await advance(0);
    const next = lastTerminal() as unknown as { history: string };
    expect(next.history).toContain("root@ct:~# ls");
    expect(next.history).toContain("reconnected: a new console");
    act(() => lastTerminal().onConsole?.({ state: "active", reason: null }));
    expect(state()).toBe("active");
  });

  it("input typed while the console is not active is refused with a visible notice, and accepted again once it is active", async () => {
    const { api } = fakeApi();
    await active(api);
    expect((lastTerminal() as unknown as { inputEnabled: boolean }).inputEnabled).toBe(true);
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    expect((lastTerminal() as unknown as { inputEnabled: boolean }).inputEnabled).toBe(false);
    act(() => lastTerminal().onInputRefused?.());
    expect(screen.getByTestId("pve-console-notice").textContent).toContain("not sent");
    await advance(1000);
    await advance(0);
    act(() => lastTerminal().onConsole?.({ state: "active", reason: null }));
    expect(screen.queryByTestId("pve-console-notice")).toBeNull();
    expect((lastTerminal() as unknown as { inputEnabled: boolean }).inputEnabled).toBe(true);
  });

  it("five attempts with 1, 2, 4, 8 and 16 s waits, then it stops with the concrete reason and says it gave up", async () => {
    let calls = 0;
    const { api } = fakeApi({
      open: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? { ok: true as const, generation: "a".repeat(32), sessionId: 1, kind: "pve" as const, node: "pve1" } : { ok: false as const, code: "unreachable", message: "", fingerprint: null };
      }),
    });
    await active(api);
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    for (const [n, wait] of [[1, 1000], [2, 2000], [3, 4000], [4, 8000], [5, 16000]] as const) {
      expect(state()).toBe(`reconnecting (${n} of 5)`);
      await advance(wait - 1);
      expect(calls).toBe(n); // not yet
      await advance(1);
      expect(calls).toBe(n + 1);
    }
    expect(state()).toBe("error");
    expect(screen.getByTestId("pve-console-reason").textContent).toContain("Gave up after 5 attempts");
    expect(screen.getByTestId("pve-console-reason").textContent).toContain("did not answer");
    await advance(60_000);
    expect(calls).toBe(6); // no sixth attempt
  });

  it.each([
    ["a login refusal", "login_failed"],
    ["a permission refusal", "no_permission"],
    ["a certificate refusal", "tls_untrusted"],
    ["a stopped guest", "guest_stopped"],
  ])("%s during an attempt stops at once: no further attempt", async (_name, code) => {
    let calls = 0;
    const { api } = fakeApi({
      open: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? { ok: true as const, generation: "a".repeat(32), sessionId: 1, kind: "pve" as const, node: "pve1" } : { ok: false as const, code, message: "m", fingerprint: null };
      }),
    });
    await active(api);
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    await advance(1000);
    expect(calls).toBe(2);
    expect(state()).toBe("error");
    await advance(120_000);
    expect(calls).toBe(2);
  });

  it("an attempt whose console opens but then fails to log in (the error arrives as a console event) is not repeated for a refusal, and is for an unreachable endpoint", async () => {
    const { api, calls } = fakeApi();
    await active(api);
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    await advance(1000);
    await advance(0);
    act(() => lastTerminal().onConsole?.({ state: "error", reason: { code: "unreachable", text: "x", fingerprint: null } }));
    expect(state()).toBe("reconnecting (2 of 5)");
    await advance(2000);
    expect(calls.open).toHaveLength(3);
    await advance(0);
    act(() => lastTerminal().onConsole?.({ state: "error", reason: { code: "login_failed", text: "x", fingerprint: null } }));
    expect(state()).toBe("error");
    await advance(120_000);
    expect(calls.open).toHaveLength(3);
  });

  it("no automatic attempt after Disconnect, an idle close or a close the owner asked for", async () => {
    const { api, calls } = fakeApi();
    await active(api);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    act(() => lastTerminal().onStateChange?.("closed", { exitCode: null, signal: null, reason: "closed_by_user" }));
    await advance(120_000);
    expect(calls.open).toHaveLength(1);
    expect(state()).toBe("disconnected");
    cleanup();
    const second = fakeApi();
    await active(second.api);
    act(() => lastTerminal().onStateChange?.("closed", { exitCode: null, signal: null, reason: "idle_timeout" }));
    await advance(120_000);
    expect(second.calls.open).toHaveLength(1);
    expect(state()).toBe("disconnected");
  });

  it("Disconnect while attempts are waiting cancels them", async () => {
    const { api, calls } = fakeApi();
    await active(api);
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    expect(state()).toBe("reconnecting (1 of 5)");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await advance(120_000);
    expect(calls.open).toHaveLength(1);
    expect(state()).toBe("disconnected");
  });

  it("a loss soon after an attempt continues the same episode; a loss after the connection held starts a new one", async () => {
    const { api } = fakeApi();
    await active(api);
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    await advance(1000);
    await advance(0);
    act(() => lastTerminal().onConsole?.({ state: "active", reason: null }));
    await advance(3000); // active for 3 s only
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    expect(state()).toBe("reconnecting (2 of 5)");
    await advance(2000);
    await advance(0);
    act(() => lastTerminal().onConsole?.({ state: "active", reason: null }));
    await advance(10_000); // it held
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    expect(state()).toBe("reconnecting (1 of 5)");
  });

  it("a graphical console is never reattached by itself: lost, and Reconnect says it opens a NEW console", async () => {
    const { api, calls } = fakeApi();
    render(<PveConsoles api={api} launch={launch(1, { console: "qemu", vmid: 200 }, "db")} />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const props = vncs[vncs.length - 1] as Record<string, (...a: unknown[]) => void>;
    act(() => props.onConsole?.({ state: "active", reason: null }));
    act(() => props.onViewState?.("ready"));
    act(() => props.onConsole?.({ state: "lost", reason: { code: "remote_closed", text: "Proxmox closed the console.", fingerprint: null } }));
    expect(state()).toBe("lost");
    expect(screen.getByTestId("pve-console-new-console").textContent).toContain("cannot be resumed");
    expect(screen.getByTestId("pve-console-new-console").textContent).toContain("NEW console");
    await advance(120_000);
    expect(calls.open).toHaveLength(1);
  });

  it("every open reads the guest's node again: a guest that moved is opened on its new node and the header shows it", async () => {
    let node = "pve1";
    const { api } = fakeApi({
      open: vi.fn(async () => ({ ok: true as const, generation: "a".repeat(32), sessionId: 1, kind: "pve" as const, node })),
    });
    await active(api);
    expect(screen.getByTestId("pve-console").textContent).toContain("container web #101 on pve1");
    node = "pve2"; // the guest moved
    act(() => lastTerminal().onStateChange?.("closed", LOST));
    await advance(1000);
    await advance(0);
    expect(screen.getByTestId("pve-console").textContent).toContain("container web #101 on pve2");
  });

  describe("work that began before Disconnect, Reconnect or Close tab", () => {
    type Opened = PveConsoleOpened;
    const okOpen = (n: number): Opened => ({ ok: true, generation: "a".repeat(32), sessionId: n, kind: "pve", node: "pve1" });
    /** The first open completes at once; later ones wait for `settle`. */
    function deferredApi() {
      const log: string[] = [];
      const pending: Array<(v: Opened) => void> = [];
      let n = 0;
      const api: PveConsolesApi = {
        open: vi.fn(async () => {
          n += 1;
          log.push("open");
          if (n === 1) return okOpen(1);
          return await new Promise<Opened>((r) => pending.push(r));
        }),
        attach: vi.fn(async (h) => (log.push("attach " + h.sessionId), { token: "tok-" + h.sessionId, wsUrl: "ws://x" })),
        close: vi.fn(async (h) => void log.push("close " + h.sessionId)),
      };
      return { api, log, pending };
    }
    async function lostAndAttempting(api: PveConsolesApi) {
      await active(api);
      act(() => lastTerminal().onStateChange?.("closed", LOST));
      await advance(1000); // attempt 1 is now opening and never answers on its own
    }

    it("probe A: a late SUCCESS after Disconnect is closed, never adopted", async () => {
      const { api, log, pending } = deferredApi();
      await lostAndAttempting(api);
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      await act(async () => pending[0]!(okOpen(2)));
      await advance(0);
      expect(log).toContain("close 2");
      expect(log).not.toContain("attach 2");
      expect(state()).toBe("disconnected");
    });

    it("probe B: a late RETRYABLE failure after Disconnect schedules nothing", async () => {
      const { api, pending } = deferredApi();
      await lostAndAttempting(api);
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      await act(async () => pending[0]!({ ok: false, code: "unreachable", message: "", fingerprint: null }));
      await advance(120_000);
      expect(api.open).toHaveBeenCalledTimes(2);
      expect(state()).toBe("disconnected");
    });

    it("Disconnect then Reconnect while the old open is pending leaves exactly one console", async () => {
      const { api, log, pending } = deferredApi();
      await lostAndAttempting(api);
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
      await advance(0);
      expect(pending).toHaveLength(2);
      await act(async () => pending[0]!(okOpen(2))); // the old open finishes late
      await act(async () => pending[1]!(okOpen(3)));
      await advance(0);
      expect(log).toContain("close 2");
      expect(log).toContain("attach 3");
      expect(log).not.toContain("attach 2");
      expect(log.filter((l) => l.startsWith("attach"))).toEqual(["attach 1", "attach 3"]);
    });

    it("an attempt closes the lost console and waits for that close before it opens the next one", async () => {
      const { api, log } = deferredApi();
      let releaseClose!: () => void;
      (api.close as ReturnType<typeof vi.fn>).mockImplementation(async (h: { sessionId: number }) => {
        log.push("close " + h.sessionId);
        await new Promise<void>((r) => (releaseClose = r));
        log.push("closed " + h.sessionId);
      });
      await active(api);
      act(() => lastTerminal().onStateChange?.("closed", LOST));
      await advance(1000);
      expect(log.filter((l) => l !== "attach 1")).toEqual(["open", "close 1"]); // the open waits for the close
      releaseClose();
      await advance(0);
      expect(log.filter((l) => l !== "attach 1")).toEqual(["open", "close 1", "closed 1", "open"]);
    });

    it("a console whose attach failed is closed, and the tab says so", async () => {
      const { api, log } = deferredApi();
      (api.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no socket"));
      render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
      await advance(0);
      expect(log).toContain("close 1");
      expect(state()).toBe("error");
      expect(screen.getByTestId("pve-console-reason").textContent).toContain("no socket");
    });

    it("events of a console that was replaced are ignored", async () => {
      const { api, pending } = deferredApi();
      await active(api);
      const oldTerminal = lastTerminal();
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
      await advance(0);
      await act(async () => pending[0]!(okOpen(5)));
      await advance(0);
      const before = state();
      act(() => oldTerminal.onConsole?.({ state: "lost", reason: { code: "remote_closed", text: "x", fingerprint: null } }));
      expect(state()).toBe(before);
    });
  });

  describe("a graphical console that Proxmox closes before it showed anything", () => {
    const lastVnc = () => vncs[vncs.length - 1] as Record<string, (...a: unknown[]) => void>;
    const closedByProxmox = () => act(() => lastVnc().onConsole?.({ state: "lost", reason: { code: "remote_closed", text: "Proxmox closed the console.", fingerprint: null } }));

    it("is opened ONCE more automatically (a new console), and says so", async () => {
      const { api, calls } = fakeApi();
      render(<PveConsoles api={api} launch={launch(1, { console: "qemu", vmid: 152 }, "vm")} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      act(() => lastVnc().onConsole?.({ state: "active", reason: null }));
      closedByProxmox();
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(calls.open).toHaveLength(2);
      expect(calls.close).toEqual([{ generation: "a".repeat(32), sessionId: 1 }]);
      expect(screen.getByTestId("pve-console-notice").textContent).toContain("A new console was opened once");
    });

    it("a second failure before any screen stops with the vnc_start_timeout text, not 'websocket error'", async () => {
      const { api, calls } = fakeApi();
      render(<PveConsoles api={api} launch={launch(1, { console: "qemu", vmid: 152 }, "vm")} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      closedByProxmox();
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      closedByProxmox();
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(calls.open).toHaveLength(2); // no third
      expect(state()).toBe("lost");
      expect(screen.getByTestId("pve-console-reason").textContent).toContain("waits only about ten seconds");
      expect(screen.getByTestId("pve-console-reason").textContent).not.toContain("websocket error");
    });

    it("a console that showed a screen is never retried by itself", async () => {
      const { api, calls } = fakeApi();
      render(<PveConsoles api={api} launch={launch(1, { console: "qemu", vmid: 152 }, "vm")} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      act(() => lastVnc().onViewState?.("ready"));
      closedByProxmox();
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(calls.open).toHaveLength(1);
      expect(state()).toBe("lost");
    });

    it("the viewer starts loading as soon as a graphical console is asked for, before the open answers; a terminal does not", async () => {
      const preload = vi.fn();
      const { api } = fakeApi({ preload, open: vi.fn(() => new Promise<PveConsoleOpened>(() => {})) });
      render(<PveConsoles api={api} launch={launch(1, { console: "qemu", vmid: 152 }, "vm")} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(preload).toHaveBeenCalledTimes(1);
      cleanup();
      const p2 = vi.fn();
      render(<PveConsoles api={fakeApi({ preload: p2 }).api} launch={launch(2, { console: "lxc", vmid: 101 })} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(p2).not.toHaveBeenCalled();
    });
  });

  describe("the tab list", () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({ id, profileId: "p1", console: "lxc" as const, node: "pve1", vmid: 101, title: "web", ...over });
    const ID1 = "11111111-1111-4111-8111-111111111111";
    const ID2 = "22222222-2222-4222-8222-222222222222";
    const store = (rows: ReturnType<typeof row>[] = []) => ({ list: vi.fn(async () => rows), put: vi.fn(async (_row: unknown) => undefined), remove: vi.fn(async (_id: string) => undefined) });

    it("a new tab is remembered as a target only and removed when the tab is closed", async () => {
      const tabs = store();
      const { api } = fakeApi({ tabs });
      render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      const saved = tabs.put.mock.calls[0]![0] as Record<string, unknown>;
      expect(saved).toMatchObject({ profileId: "p1", console: "lxc", node: null, vmid: 101, title: "web" });
      expect(Object.keys(saved).sort()).toEqual(["console", "id", "node", "profileId", "title", "vmid"]);
      fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
      expect(tabs.remove).toHaveBeenCalledWith(saved.id);
    });

    it("the saved row of a guest never carries a node (the RPC refuses it), only a node shell does, and a failed save is shown", async () => {
      const tabs = store();
      const { api } = fakeApi({ tabs });
      render(<PveConsoles api={api} launch={launch(1, { console: "lxc", vmid: 101 })} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(tabs.put).toHaveBeenCalledTimes(1); // no second save with the resolved node
      expect((tabs.put.mock.calls[0]![0] as { node: unknown }).node).toBeNull();
      cleanup();
      const shell = store();
      render(<PveConsoles api={fakeApi({ tabs: shell }).api} launch={launch(2, { console: "node", node: "pve1" }, "pve1")} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(shell.put).toHaveBeenCalledWith(expect.objectContaining({ console: "node", node: "pve1", vmid: null }));
      cleanup();
      const broken = store();
      broken.put.mockRejectedValue(new Error("a node shell names its node"));
      render(<PveConsoles api={fakeApi({ tabs: broken }).api} launch={launch(3, { console: "lxc", vmid: 102 })} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(screen.getByTestId("pve-console-notice").textContent).toContain("could not be remembered");
    });

    it("tabs come back after a restart as 'not connected', open nothing, and Reconnect opens a new console", async () => {
      const tabs = store([row(ID1), row(ID2, { console: "qemu", vmid: 200, title: "db" })]);
      const { api, calls } = fakeApi({ tabs });
      render(<PveConsoles api={api} connectionName={() => "lab"} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(screen.getAllByTestId("pve-console")).toHaveLength(2);
      expect(screen.getAllByTestId("pve-console-state").map((e) => e.textContent)).toEqual(["not connected", "not connected"]);
      expect(screen.getAllByTestId("pve-console-restored")[0]!.textContent).toContain("not connected");
      expect(screen.getAllByTestId("pve-console")[0]!.textContent).toContain("lab");
      expect(calls.open).toEqual([]);
      expect(calls.attach).toEqual([]);
      expect(screen.queryByTestId("terminal")).toBeNull();
      expect((screen.getAllByRole("button", { name: "Disconnect" })[0] as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getAllByRole("button", { name: "Reconnect" })[0]!);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(calls.open).toEqual([{ console: "lxc", vmid: 101, profileId: "p1", cols: 80, rows: 24 }]);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(screen.getByTestId("terminal")).toBeTruthy();
    });

    it("closing a restored tab forgets it", async () => {
      const tabs = store([row(ID1)]);
      const { api } = fakeApi({ tabs });
      render(<PveConsoles api={api} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
      expect(tabs.remove).toHaveBeenCalledWith(ID1);
      expect(screen.queryByTestId("pve-console")).toBeNull();
    });
  });
});
