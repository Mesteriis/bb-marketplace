// @vitest-environment jsdom
// The Proxmox consoles on the desk: each console is a desk pane, and the desk follows the consoles.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} /> }));
import { createDeskStore } from "./desk-store.ts";
import { DeskContext } from "./desk/desk-context.tsx";
import { Desk } from "./desk/desk.tsx";
import { PveConsoles, type PveConsoleLaunch, type PveConsolesApi } from "./pve-consoles.tsx";

const terminals: Array<Record<string, (...a: unknown[]) => void>> = [];
vi.mock("./ssh-terminal.tsx", () => ({
  SshTerminal: (props: Record<string, (...a: unknown[]) => void>) => {
    terminals.push(props);
    return <div data-testid="terminal" />;
  },
}));
vi.mock("./vnc-view.tsx", () => ({ VncView: () => <div data-testid="vnc" /> }));

afterEach(() => {
  cleanup();
  terminals.length = 0;
});

const launch = (nonce: number, request: PveConsoleLaunch["request"], title: string): PveConsoleLaunch => ({ nonce, profileId: "p1", connectionName: "Proxmox", request, title });

function api(): { api: PveConsolesApi; closed: unknown[] } {
  let n = 0;
  const closed: unknown[] = [];
  return {
    closed,
    api: {
      open: vi.fn(async (input) => ({ ok: true as const, generation: "a".repeat(32), sessionId: ++n, kind: input.console === "qemu" ? ("vnc" as const) : ("pve" as const), node: "pve" })),
      attach: vi.fn(async (h) => ({ token: "tok-" + h.sessionId, wsUrl: "ws://x/attach" })),
      close: vi.fn(async (h) => void closed.push(h)),
    },
  };
}

describe("PveConsoles on the desk", () => {
  it("a console becomes a desk session and a pane named after the guest", async () => {
    const store = createDeskStore();
    const fake = api();
    render(
      <DeskContext.Provider value={store}>
        <Desk>
          <PveConsoles desk api={fake.api} launch={launch(1, { console: "lxc", vmid: 165 }, "rdp-ssh-test")} />
        </Desk>
      </DeskContext.Provider>,
    );
    expect(await screen.findByTestId("terminal")).toBeTruthy();
    act(() => terminals[terminals.length - 1]?.onConsole?.({ state: "active", reason: null }));
    expect(store.get().sessions.map((s) => [s.kind, s.title, s.detail, s.state, s.owner])).toEqual([["pve-terminal", "rdp-ssh-test", "LXC 165 · Proxmox", "active", "human"]]);
    const pane = screen.getByTestId("desk-pane");
    expect(pane.getAttribute("aria-label")).toBe("rdp-ssh-test");
    expect(screen.getByTestId("session-status").textContent).toBe("подключено");
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("names a node shell and a virtual machine", async () => {
    const store = createDeskStore();
    const fake = api();
    const { rerender } = render(
      <DeskContext.Provider value={store}>
        <PveConsoles desk api={fake.api} launch={launch(1, { console: "node", node: "pve" }, "")} />
      </DeskContext.Provider>,
    );
    await screen.findByTestId("terminal");
    rerender(
      <DeskContext.Provider value={store}>
        <PveConsoles desk api={fake.api} launch={launch(2, { console: "qemu", vmid: 152 }, "astra-linux")} />
      </DeskContext.Provider>,
    );
    await screen.findByTestId("vnc");
    expect(store.get().sessions.map((s) => [s.kind, s.title, s.detail])).toEqual([
      ["pve-terminal", "Узел pve", "оболочка · Proxmox"],
      ["pve-graphics", "astra-linux", "VM 152 · Proxmox"],
    ]);
  });

  it("Close in the pane closes the console and takes the session off the desk", async () => {
    const store = createDeskStore();
    const fake = api();
    render(
      <DeskContext.Provider value={store}>
        <Desk>
          <PveConsoles desk api={fake.api} launch={launch(1, { console: "lxc", vmid: 165 }, "rdp-ssh-test")} />
        </Desk>
      </DeskContext.Provider>,
    );
    await screen.findByTestId("terminal");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Закрыть" })));
    expect(fake.closed).toEqual([{ generation: "a".repeat(32), sessionId: 1 }]);
    expect(store.get().sessions).toEqual([]);
    expect(screen.getByTestId("desk-empty")).toBeTruthy();
  });
});
