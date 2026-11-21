// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DeskSession } from "../../core/desk.ts";
import { createDeskStore, type DeskStore } from "../desk-store.ts";
import { closeDeskSession, DeskContext } from "./desk-context.tsx";
import { DeskPane } from "./desk-pane.tsx";
import { Desk } from "./desk.tsx";

vi.mock("@/components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} /> }));

afterEach(cleanup);

const lxc = (id: string, vmid: number, title: string, extra: Partial<DeskSession> = {}): DeskSession => ({
  id, kind: "pve-terminal", title, detail: `LXC ${vmid}`, target: { type: "pve", profileId: "p", console: "lxc", vmid }, state: "active", owner: "human", attempt: 0, reason: null, ...extra,
});

function show(store: DeskStore, onClose: (id: string) => void = () => undefined) {
  return render(
    <DeskContext.Provider value={store}>
      <Desk>
        {store.get().sessions.map((s) => (
          <DeskPane key={s.id} session={s} onClose={() => onClose(s.id)}>
            <p>screen of {s.title}</p>
          </DeskPane>
        ))}
      </Desk>
    </DeskContext.Provider>,
  );
}

describe("Desk", () => {
  it("says what to do while nothing is open", () => {
    show(createDeskStore());
    expect(screen.getByTestId("desk-empty").textContent).toContain("Выберите подключение слева");
  });

  it("shows only the focused session in one pane and keeps the other mounted but hidden", () => {
    const store = createDeskStore();
    store.open(lxc("a", 165, "rdp-ssh-test"));
    store.open(lxc("b", 110, "db"));
    show(store);
    const panes = screen.getAllByTestId("desk-pane", { hidden: true } as never);
    expect(panes.map((p) => [p.getAttribute("aria-label"), p.hidden])).toEqual([
      ["rdp-ssh-test", true],
      ["db", false],
    ]);
    expect(screen.getByText("screen of rdp-ssh-test")).toBeTruthy();
  });

  it("puts two sessions side by side in the order the desk gives", () => {
    const store = createDeskStore();
    store.open(lxc("a", 165, "rdp-ssh-test"));
    store.open(lxc("b", 110, "db"));
    show(store);
    fireEvent.click(screen.getByRole("button", { name: "Два экрана" }));
    const panes = screen.getAllByTestId("desk-pane");
    expect(panes.map((p) => [p.getAttribute("aria-label"), p.style.order])).toEqual([
      ["rdp-ssh-test", "1"],
      ["db", "0"],
    ]);
    expect(screen.getByTestId("desk-grid").style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("names the state and the driver in the pane header", () => {
    const store = createDeskStore();
    store.open(lxc("a", 165, "rdp-ssh-test", { owner: "agent" }));
    show(store);
    expect(screen.getByTestId("session-status").textContent).toBe("подключено");
    expect(screen.getByTestId("desk-pane-owner").textContent).toBe("управляет агент");
  });

  it("a session that is reconnecting shows the attempt and no driver", () => {
    const store = createDeskStore();
    store.open(lxc("a", 165, "rdp-ssh-test", { state: "reconnecting", attempt: 2 }));
    show(store);
    expect(screen.getByTestId("session-status").textContent).toBe("переподключение 2 из 5");
    expect(screen.queryByTestId("desk-pane-owner")).toBeNull();
  });

  it("can select the split layout before opening a session", () => {
    const store = createDeskStore();
    show(store);
    fireEvent.click(screen.getByRole("button", { name: "Два экрана" }));
    expect(store.get().layout).toBe("two");
    expect(screen.getByRole("button", { name: "Два экрана" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("moves input focus between split panes without remounting their contents", () => {
    const store = createDeskStore();
    store.open(lxc("a", 165, "lab-node"));
    store.open(lxc("b", 110, "test-vm", { kind: "rdp" }));
    store.layout("two");
    show(store);
    const terminal = screen.getByText("screen of lab-node");
    const desktop = screen.getByText("screen of test-vm");
    fireEvent.pointerDown(terminal);
    expect(store.get().focus).toBe("a");
    expect(terminal.closest("section")?.getAttribute("data-focused")).toBe("true");
    expect(desktop.closest("section")?.getAttribute("data-focused")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Один экран" }));
    expect(desktop.closest("section")?.hidden).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Два экрана" }));
    expect(screen.getByText("screen of test-vm")).toBe(desktop);
    expect(screen.getByText("screen of lab-node")).toBe(terminal);
    expect(screen.getByText("RDP")).toBeTruthy();
  });

  it("closing from elsewhere runs the pane's own close action", () => {
    const store = createDeskStore();
    store.open(lxc("a", 165, "rdp-ssh-test"));
    const onClose = vi.fn();
    show(store, onClose);
    closeDeskSession(store, "a");
    expect(onClose).toHaveBeenCalledWith("a");
  });
});
