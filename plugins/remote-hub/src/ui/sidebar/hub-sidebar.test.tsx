// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeskSession } from "../../core/desk.ts";
import { HubSidebar, type HubSidebarProps } from "./hub-sidebar.tsx";

vi.mock("@/components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} /> }));

afterEach(cleanup);

const session: DeskSession = { id: "a", kind: "pve-terminal", title: "rdp-ssh-test", detail: "LXC 165 · Proxmox", target: { type: "pve", profileId: "pve1", console: "lxc", vmid: 165 }, state: "active", owner: "human", attempt: 0, reason: null };

function props(over: Partial<HubSidebarProps> = {}): HubSidebarProps {
  return {
    profiles: [
      { id: "pve1", name: "Proxmox", protocol: "pve", group: null, detail: "remotehub@pve@10.34.10.2" },
      { id: "s1", name: "win-test", protocol: "rdp", group: "Стенд", detail: "admin@10.34.10.70" },
    ],
    error: null,
    connections: { pve1: { outcome: "ok", nodes: ["pve"], guests: [{ vmid: 165, name: "rdp-ssh-test", kind: "lxc", node: "pve", status: "running", template: false, available: true }, { vmid: 152, name: "astra-linux", kind: "qemu", node: "pve", status: "stopped", template: false, available: false }] } },
    sessions: [],
    shown: [],
    onFocusSession: vi.fn(), onCloseSession: vi.fn(), onExpand: vi.fn(), onConnect: vi.fn(), onConsole: vi.fn(), onEdit: vi.fn(), onAdd: vi.fn(), onCredentials: vi.fn(), onAgents: vi.fn(), onAllow: vi.fn(), onGuests: vi.fn(), onRetry: vi.fn(),
    ...over,
  };
}

describe("HubSidebar", () => {
  it("lists the saved connections by group and asks for a Proxmox connection's guests when it is opened", () => {
    const p = props();
    render(<HubSidebar {...p} />);
    expect(screen.getByText("Подключения")).toBeTruthy();
    expect(screen.getByText("Стенд")).toBeTruthy();
    expect(screen.queryByText("rdp-ssh-test")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Proxmox/ }));
    expect(p.onExpand).toHaveBeenCalledWith("pve1");
    expect(screen.getByText("Узел pve")).toBeTruthy();
    expect(screen.getByText("LXC 165")).toBeTruthy();
  });

  it("opens a container console, a node shell and a saved connection", () => {
    const p = props();
    render(<HubSidebar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /^Proxmox/ }));
    fireEvent.click(screen.getByRole("button", { name: /rdp-ssh-test/ }));
    fireEvent.click(screen.getByRole("button", { name: /Узел pve/ }));
    fireEvent.click(screen.getByRole("button", { name: /^win-test/ }));
    expect(p.onConsole).toHaveBeenNthCalledWith(1, "pve1", { console: "lxc", vmid: 165 }, "rdp-ssh-test");
    expect(p.onConsole).toHaveBeenNthCalledWith(2, "pve1", { console: "node", node: "pve" }, "");
    expect(p.onConnect).toHaveBeenCalledWith("s1");
  });

  it("a stopped guest cannot be opened and says why", () => {
    render(<HubSidebar {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Proxmox/ }));
    const stopped = screen.getByRole("button", { name: /astra-linux/ }) as HTMLButtonElement;
    expect(stopped.disabled).toBe(true);
    expect(stopped.title).toBe("выключен");
  });

  it("the running filter hides stopped guests", () => {
    render(<HubSidebar {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Proxmox/ }));
    fireEvent.click(screen.getByRole("button", { name: "Работают" }));
    expect(screen.queryByText("astra-linux")).toBeNull();
    expect(screen.getByText("rdp-ssh-test")).toBeTruthy();
  });

  it("shows the open sessions above the tree, marks the one on screen and closes one on request", () => {
    const p = props({ sessions: [session], shown: ["a"] });
    render(<HubSidebar {...p} />);
    expect(screen.getByText("Открыто сейчас")).toBeTruthy();
    const row = screen.getByTestId("sidebar-session");
    expect(row.textContent).toContain("rdp-ssh-test");
    expect(row.textContent).toContain("терминал");
    expect(row.querySelector("button")?.getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Закрыть: rdp-ssh-test" }));
    expect(p.onCloseSession).toHaveBeenCalledWith("a");
  });

  it("a session card shows the terminal's last lines, or the desktop's frame, and says when an agent drives it", () => {
    const desktop: DeskSession = { ...session, id: "b", kind: "pve-graphics", title: "win11", owner: "agent" };
    render(<HubSidebar {...props({ sessions: [session, desktop], shown: ["a"], thumbs: { a: { type: "text", lines: ["$ uptime", " 10:02 up 3 days"] }, b: { type: "image", url: "data:image/jpeg;base64,AAAA" } } })} />);
    const [first, second] = screen.getAllByTestId("sidebar-session");
    expect(first!.querySelector("[data-testid=sidebar-thumb]")!.textContent).toBe("$ uptime\n 10:02 up 3 days");
    expect(second!.querySelector("img")!.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(second!.textContent).toContain("управляет агент");
  });

  it("a connection macOS has not allowed offers Allow access", () => {
    const p = props({ connections: { pve1: { outcome: "keychain_needs_approval", nodes: [], guests: [] } } });
    render(<HubSidebar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /^Proxmox/ }));
    expect(screen.getByTestId("sidebar-problem").textContent).toContain("macOS не разрешил этой сборке читать сохранённый пароль");
    fireEvent.click(screen.getByRole("button", { name: "Разрешить доступ" }));
    expect(p.onAllow).toHaveBeenCalledWith("pve1");
  });

  it("a connection whose certificate is not trusted leads to its guest list on the page", () => {
    const p = props({ connections: { pve1: { outcome: "tls_untrusted", nodes: [], guests: [] } } });
    render(<HubSidebar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /^Proxmox/ }));
    expect(screen.getByTestId("sidebar-problem").textContent).toContain("Список не прочитан: сертификат не доверенный");
    fireEvent.click(screen.getByRole("button", { name: "Подробнее" }));
    expect(p.onGuests).toHaveBeenCalledWith("pve1");
  });

  it("says when nothing is saved and when a search finds nothing", () => {
    const { rerender } = render(<HubSidebar {...props({ profiles: [] })} />);
    expect(screen.getByTestId("sidebar-empty").textContent).toBe("Подключений пока нет");
    rerender(<HubSidebar {...props()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByTestId("sidebar-empty").textContent).toBe("Ничего не найдено");
  });
});
