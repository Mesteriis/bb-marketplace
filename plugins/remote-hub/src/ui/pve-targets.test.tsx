// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../core/profile.ts";
import type { PveConnectionView, PveGuestView } from "../core/pve-targets.ts";
import type { PveApi } from "./pve-api.ts";
import { PveTargets, CONSOLE_OFF_REASON } from "./pve-targets.tsx";

afterEach(cleanup);

const FP = "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E";
const guest = (profileId: string, over: Partial<PveGuestView> & { vmid: number; name: string }): PveGuestView => ({
  key: `${profileId}/${over.vmid}`, profileId, kind: "lxc", node: "pve1", status: "running", template: false, console: { available: true, reason: null }, linkedProfileId: null, ...over,
});
const conn = (profileId: string, name: string, over: Partial<PveConnectionView> = {}): PveConnectionView => ({
  profileId, profileName: name, credentialRef: null, outcome: "ok", message: null, fingerprint: null, version: "9.0.3", nodes: [], guests: [], fetchedAt: "2026-11-18T12:00:00.000Z", stale: null, ...over,
});
const ssh = { id: "ssh-1", name: "web shell", protocol: "ssh" } as unknown as Profile;

function api(connections: PveConnectionView[]): PveApi & { targets: ReturnType<typeof vi.fn>; pinTrust: ReturnType<typeof vi.fn>; linkGuest: ReturnType<typeof vi.fn> } {
  return {
    targets: vi.fn(async () => ({ connections })),
    pinTrust: vi.fn(async () => ({ pinned: true })),
    linkGuest: vi.fn(async () => ({ linked: true })),
    onboardPlan: vi.fn(),
    onboardApply: vi.fn(),
    onboardConnect: vi.fn(),
    openConsole: vi.fn(),
  } as never;
}

function mount(a: PveApi, extra: Partial<Parameters<typeof PveTargets>[0]> = {}) {
  const onConnectProfile = vi.fn();
  const onClose = vi.fn();
  render(<PveTargets api={a} profileIds={null} linkable={[ssh]} onConnectProfile={onConnectProfile} onClose={onClose} {...extra} />);
  return { onConnectProfile, onClose };
}

describe("PveTargets", () => {
  it("shows each connection with its own outcome, so one failing never hides the other", async () => {
    mount(api([conn("a", "env-a", { guests: [guest("a", { vmid: 101, name: "web" })] }), conn("b", "env-b", { outcome: "login_failed", message: "Proxmox refused the login." })]));
    const sections = await screen.findAllByTestId("pve-connection");
    expect(sections).toHaveLength(2);
    expect(within(sections[0]!).getByTestId("pve-outcome").textContent).toBe("подключено");
    expect(within(sections[0]!).getByText("web")).toBeTruthy();
    expect(within(sections[1]!).getByTestId("pve-outcome").textContent).toBe("вход отклонён");
    expect(within(sections[1]!).getByText(/^Proxmox отклонил вход\./)).toBeTruthy();
  });

  it("has no power buttons; without console support the button is off with its reason, and a stopped guest says why", async () => {
    mount(api([conn("a", "env-a", { guests: [guest("a", { vmid: 101, name: "web" }), guest("a", { vmid: 102, name: "old", status: "stopped", console: { available: false, reason: "the guest is stopped; start it in Proxmox first (Remote Hub never starts guests)" } })] })]));
    const cards = await screen.findAllByTestId("pve-guest");
    for (const word of ["Start", "Stop", "Shutdown", "Reboot", "Migrate", "Snapshot", "Delete"]) expect(screen.queryByRole("button", { name: new RegExp(word, "i") })).toBeNull();
    const [web, old] = cards as [HTMLElement, HTMLElement];
    expect((within(web).getByRole("button", { name: /Открыть консоль: web/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(web).getByTestId("pve-console-reason").textContent).toBe(CONSOLE_OFF_REASON);
    expect((within(old).getByRole("button", { name: /Открыть консоль: old/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(old).getByTestId("pve-console-reason").textContent).toContain("гость выключен");
  });

  it("with console support the buttons open a node shell, a container console and a VM's graphics; a stopped guest stays off", async () => {
    const onOpenConsole = vi.fn();
    const a = api([conn("a", "env-a", { nodes: [{ node: "pve1", status: "online" }, { node: "pve2", status: "offline" }], guests: [guest("a", { vmid: 101, name: "web" }), guest("a", { vmid: 200, name: "db", kind: "qemu", node: "pve1" }), guest("a", { vmid: 102, name: "old", status: "stopped", console: { available: false, reason: "stopped" } })] })]);
    render(<PveTargets api={a} profileIds={null} linkable={[]} onConnectProfile={vi.fn()} onOpenConsole={onOpenConsole} onClose={vi.fn()} />);
    const cards = await screen.findAllByTestId("pve-guest");
    const [web, db, old] = cards as [HTMLElement, HTMLElement, HTMLElement];
    fireEvent.click(within(web).getByRole("button", { name: /Открыть консоль: web/ }));
    expect(onOpenConsole).toHaveBeenLastCalledWith({ profileId: "a", connectionName: "env-a", request: { console: "lxc", vmid: 101 }, title: "web" });
    expect(within(db).getByRole("button", { name: /Открыть консоль: db/ }).textContent).toBe("Открыть графику");
    fireEvent.click(within(db).getByRole("button", { name: /Открыть консоль: db/ }));
    expect(onOpenConsole).toHaveBeenLastCalledWith({ profileId: "a", connectionName: "env-a", request: { console: "qemu", vmid: 200 }, title: "db" });
    expect((within(old).getByRole("button", { name: /Открыть консоль: old/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Открыть оболочку узла pve1" }));
    expect(onOpenConsole).toHaveBeenLastCalledWith({ profileId: "a", connectionName: "env-a", request: { console: "node", node: "pve1" }, title: "pve1" });
    expect((screen.getByRole("button", { name: "Открыть оболочку узла pve2" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("searches by name, id, node and type", async () => {
    mount(api([conn("a", "env-a", { guests: [guest("a", { vmid: 101, name: "web" }), guest("a", { vmid: 200, name: "db", kind: "qemu", node: "pve2" })] })]));
    await screen.findAllByTestId("pve-guest");
    const search = screen.getByLabelText("Поиск гостей");
    fireEvent.change(search, { target: { value: "db" } });
    expect(screen.getAllByTestId("pve-guest")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "101" } });
    expect(screen.getByText("web")).toBeTruthy();
    fireEvent.change(search, { target: { value: "pve2" } });
    expect(screen.getByText("db")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nothing" } });
    expect(screen.getByText("Ни один гость не подходит.")).toBeTruthy();
  });

  it("refresh asks again with refresh set", async () => {
    const a = api([conn("a", "env-a")]);
    mount(a);
    await screen.findByTestId("pve-connection");
    expect(a.targets).toHaveBeenLastCalledWith({ refresh: false });
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(a.targets).toHaveBeenLastCalledWith({ refresh: true }));
  });

  it("an untrusted certificate shows its fingerprint and trusting it pins that exact one, then refreshes", async () => {
    const a = api([conn("a", "env-a", { outcome: "tls_untrusted", fingerprint: FP, message: "The server certificate is not trusted." })]);
    mount(a);
    const cert = await screen.findByTestId("pve-cert");
    expect(cert.textContent).toContain(FP);
    fireEvent.click(within(cert).getByRole("button", { name: "Доверять этому сертификату" }));
    await waitFor(() => expect(a.pinTrust).toHaveBeenCalledWith("a", FP));
    await waitFor(() => expect(a.targets).toHaveBeenLastCalledWith({ refresh: true }));
  });

  it("a changed certificate says so in the button", async () => {
    mount(api([conn("a", "env-a", { outcome: "cert_changed", fingerprint: FP })]));
    expect(await screen.findByRole("button", { name: "Доверять новому сертификату" })).toBeTruthy();
  });

  it("stale data says how old it is", async () => {
    mount(api([conn("a", "env-a", { outcome: "unreachable", stale: { ageSeconds: 120 }, guests: [guest("a", { vmid: 101, name: "web" })] })]));
    expect((await screen.findByTestId("pve-stale")).textContent).toContain("2 мин назад");
  });

  it("an empty list is stated, not shown as an error", async () => {
    mount(api([conn("a", "env-a", { outcome: "empty" })]));
    expect(await screen.findByText("Учётная запись не видит ни виртуальных машин, ни контейнеров.")).toBeTruthy();
  });

  it("links a guest to an SSH profile the owner picks, and connects through it", async () => {
    const a = api([conn("a", "env-a", { guests: [guest("a", { vmid: 101, name: "web" })] })]);
    mount(a);
    const select = (await screen.findByLabelText("Связанное подключение: web")) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["нет", "web shell (SSH)"]);
    fireEvent.change(select, { target: { value: "ssh-1" } });
    await waitFor(() => expect(a.linkGuest).toHaveBeenCalledWith("a", 101, "ssh-1"));
  });

  it("a linked guest offers Connect through the linked profile", async () => {
    const { onConnectProfile } = mount(api([conn("a", "env-a", { guests: [guest("a", { vmid: 101, name: "web", linkedProfileId: "ssh-1" })] })]));
    fireEvent.click(await screen.findByRole("button", { name: "Подключиться к web через web shell" }));
    expect(onConnectProfile).toHaveBeenCalledWith("ssh-1");
  });

  it("a failing request is shown, not swallowed", async () => {
    const a = api([]);
    a.targets.mockRejectedValueOnce(new Error("helper is not running"));
    mount(a);
    expect(await screen.findByText("helper is not running")).toBeTruthy();
  });

  it("a connection whose saved password macOS has not let this build read gets an Allow access button that names its credential", async () => {
    const onAllowAccess = vi.fn(async (_ref: string) => ({}));
    const a = api([conn("a", "env-a", { outcome: "keychain_needs_approval", message: "macOS has not allowed this Remote Hub build", credentialRef: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01" })]);
    mount(a, { onAllowAccess });
    fireEvent.click(await screen.findByRole("button", { name: "Разрешить доступ" }));
    await waitFor(() => expect(onAllowAccess).toHaveBeenCalledWith("rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01"));
    // the list is read again afterwards
    await waitFor(() => expect(a.targets).toHaveBeenCalledTimes(2));
    expect((await screen.findByTestId("pve-outcome")).textContent).toBe("нужно разрешение");
  });

  it("a locked Keychain shows its own outcome and no button; without the action there is no button either", async () => {
    const locked = api([conn("a", "env-a", { outcome: "keychain_locked", message: "The login Keychain is locked.", credentialRef: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01" })]);
    mount(locked, { onAllowAccess: vi.fn() });
    expect((await screen.findByTestId("pve-outcome")).textContent).toBe("Связка ключей заблокирована");
    expect(screen.queryByRole("button", { name: "Разрешить доступ" })).toBeNull();
    cleanup();
    mount(api([conn("a", "env-a", { outcome: "keychain_needs_approval", message: "m", credentialRef: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b01" })]));
    await screen.findByTestId("pve-outcome");
    expect(screen.queryByRole("button", { name: "Разрешить доступ" })).toBeNull();
  });
});
