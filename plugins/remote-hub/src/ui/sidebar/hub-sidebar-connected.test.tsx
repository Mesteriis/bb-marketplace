// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../../core/profile.ts";
import type { PveConnectionView } from "../../core/pve-targets.ts";
import { createDeskStore } from "../desk-store.ts";
import { DeskContext } from "../desk/desk-context.tsx";
import { createHubBus, type HubCommand } from "../hub-bus.ts";
import { HubSidebarConnected } from "./hub-sidebar-connected.tsx";

vi.mock("@/components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} /> }));

afterEach(cleanup);

const profile = (over: Partial<Profile>): Profile => ({ id: "x", name: "x", protocol: "ssh", host: "10.0.0.5", port: null, username: "root", group: null, credentialRef: null, ...over }) as Profile;
const PVE = profile({ id: "pve1", name: "Proxmox", protocol: "pve", host: "10.0.0.2", port: 8006, username: "remotehub@pve" });
const SSH = profile({ id: "s1", name: "web", protocol: "ssh" });

function view(over: Partial<PveConnectionView> = {}): PveConnectionView {
  return {
    profileId: "pve1", profileName: "Proxmox", credentialRef: "cred-1", outcome: "ok", message: null, fingerprint: null, version: "9.0", fetchedAt: null, stale: null,
    nodes: [{ node: "pve" }] as PveConnectionView["nodes"],
    guests: [{ key: "pve1/165", profileId: "pve1", vmid: 165, name: "rdp-ssh-test", kind: "lxc", node: "pve", status: "running", template: false, console: { available: true, reason: null }, linkedProfileId: null }],
    ...over,
  };
}

function setup(targets = vi.fn(async () => ({ connections: [view()] })), allow = vi.fn(async () => ({}))) {
  const bus = createHubBus();
  const sent: HubCommand[] = [];
  bus.subscribe((c) => sent.push(c));
  const store = createDeskStore();
  const list = vi.fn(async () => [PVE, SSH]);
  const api = { list, save: vi.fn(), remove: vi.fn(), duplicate: vi.fn(), sessions: vi.fn(async () => []) };
  render(
    <DeskContext.Provider value={store}>
      <HubSidebarConnected profiles={api} pve={{ targets }} allow={allow} bus={bus} />
    </DeskContext.Provider>,
  );
  return { bus, sent, store, list, targets, allow };
}

describe("HubSidebarConnected", () => {
  it("reads a Proxmox connection's guests when it is opened and sends a console request with the connection's name", async () => {
    const { sent, targets } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /^Proxmox/ }));
    expect(targets).toHaveBeenCalledWith({ profileIds: ["pve1"], refresh: false });
    fireEvent.click(await screen.findByRole("button", { name: /rdp-ssh-test/ }));
    expect(sent).toEqual([{ type: "console", profileId: "pve1", connectionName: "Proxmox", request: { console: "lxc", vmid: 165 }, title: "rdp-ssh-test" }]);
  });

  it("sends connect for a saved SSH connection and shows its address as the tooltip", async () => {
    const { sent } = setup();
    const row = await screen.findByRole("button", { name: /^web/ });
    expect(row.title).toBe("root@10.0.0.5");
    fireEvent.click(row);
    expect(sent).toEqual([{ type: "connect", profileId: "s1" }]);
  });

  it("Allow access asks macOS for the connection's saved password and reads the guests again", async () => {
    const targets = vi.fn(async () => ({ connections: [view({ outcome: "keychain_needs_approval", nodes: [], guests: [] })] }));
    const { allow } = setup(targets);
    fireEvent.click(await screen.findByRole("button", { name: /^Proxmox/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Разрешить доступ" }));
    expect(allow).toHaveBeenCalledWith("cred-1");
    await act(async () => {});
    expect(targets).toHaveBeenLastCalledWith({ profileIds: ["pve1"], refresh: true });
  });

  it("reloads the list when the page says the connections changed", async () => {
    const { bus, list } = setup();
    await screen.findByRole("button", { name: /^web/ });
    await act(async () => bus.changed());
    expect(list).toHaveBeenCalledTimes(2);
  });
});
