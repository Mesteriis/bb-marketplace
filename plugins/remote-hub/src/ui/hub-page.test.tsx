// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} /> }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

import type { Profile } from "../core/profile.ts";
import { createDeskStore } from "./desk-store.ts";
import { DeskContext } from "./desk/desk-context.tsx";
import { createHubBus } from "./hub-bus.ts";
import { HubPage } from "./hub-page.tsx";

afterEach(cleanup);

const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const stored = (over: Partial<Profile> & { id: string; name: string }): Profile =>
  ({ executionHostId: "local", origin: "manual", createdAt: "2026-11-18T10:00:00.000Z", updatedAt: "2026-11-18T10:00:00.000Z", lastOpenedAt: null, recentErrors: [], protocol: "ssh", group: null, tags: [], favorite: false, color: null, host: "h.example.test", port: null, username: "root", domain: null, authType: "agent", identityFile: null, credentialRef: null, rdpWidth: null, rdpHeight: null, ...over }) as Profile;

function setup(credentials?: { save: ReturnType<typeof vi.fn> }) {
  const bus = createHubBus();
  const store = createDeskStore();
  const profiles = [stored({ id: SID, name: "web" }), stored({ id: RID, name: "win", protocol: "rdp", username: "admin" })];
  const api = { list: vi.fn(async () => profiles), save: vi.fn(), remove: vi.fn(async () => ({ deleted: true })), duplicate: vi.fn(async () => profiles[0]!), sessions: vi.fn(async () => []) };
  // The open never settles: the session stays "connecting", which is all these cases look at.
  const ssh = { onSshOpen: vi.fn(() => new Promise<never>(() => undefined)), onAttach: vi.fn(), onClose: vi.fn() };
  const rdp = { onRdpOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn(), onDecision: vi.fn(), onScreenshot: vi.fn() };
  const changed = vi.fn();
  bus.onChanged(changed);
  render(
    <DeskContext.Provider value={store}>
      <HubPage ssh={ssh as never} rdp={rdp as never} profiles={api as never} {...(credentials !== undefined ? { credentials: { list: vi.fn(async () => []), update: vi.fn(), remove: vi.fn(), status: vi.fn(), allow: vi.fn(), allowAll: vi.fn(), ...credentials } as never } : {})} bus={bus} />
    </DeskContext.Provider>,
  );
  return { bus, store, api, ssh, changed };
}

describe("HubPage", () => {
  it("starts with an empty desk and no secondary screen", () => {
    setup();
    expect(screen.getByTestId("desk-empty").textContent).toContain("Выберите подключение слева");
    expect(screen.queryByTestId("hub-screen")).toBeNull();
  });

  it("connect from the sidebar opens the saved SSH connection as a desk session named after it", async () => {
    const { bus, store, ssh } = setup();
    act(() => bus.send({ type: "connect", profileId: SID }));
    await waitFor(() => expect(ssh.onSshOpen).toHaveBeenCalledTimes(1));
    expect(ssh.onSshOpen.mock.calls[0]).toEqual([{ host: "h.example.test", user: "root", extraOptions: [] }, SID, undefined]);
    expect(store.get().sessions.map((s) => [s.id, s.kind, s.title, s.detail, s.state])).toEqual([["ssh", "ssh", "web", "root@h.example.test", "connecting"]]);
    expect(store.get().shown).toEqual(["ssh"]);
    expect(screen.queryByTestId("desk-empty")).toBeNull();
  });

  it("an RDP connection becomes a second session beside the SSH one, waiting for its password", async () => {
    const { bus, store } = setup();
    act(() => bus.send({ type: "connect", profileId: SID }));
    await waitFor(() => expect(store.get().sessions.length).toBe(1));
    act(() => bus.send({ type: "connect", profileId: RID }));
    await waitFor(() => expect(store.get().sessions.length).toBe(2));
    expect(store.get().sessions.map((s) => [s.id, s.title, s.detail, s.state])).toEqual([
      ["ssh", "web", "root@h.example.test", "connecting"],
      ["rdp", "win", "admin@h.example.test", "not_connected"],
    ]);
    expect(store.get().shown).toEqual(["rdp"]);
  });

  it("edit shows the editor in place of the desk and Back returns to the sessions", async () => {
    const { bus } = setup();
    act(() => bus.send({ type: "edit", profileId: SID }));
    expect(await screen.findByTestId("hub-screen")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Дублировать" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /К сессиям/ }));
    expect(screen.queryByTestId("hub-screen")).toBeNull();
  });

  it("deleting asks first, then removes the connection with its password and tells the sidebar", async () => {
    const { bus, api, changed } = setup();
    act(() => bus.send({ type: "edit", profileId: SID }));
    fireEvent.click(await screen.findByRole("button", { name: "Удалить" }));
    expect(api.remove).not.toHaveBeenCalled();
    expect(screen.getByText(/Удалить «web»\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(SID, true));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("hub-screen")).toBeNull();
  });

  const fillNew = (bus: ReturnType<typeof createHubBus>) => {
    act(() => bus.send({ type: "edit", profileId: null }));
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "db" } });
    fireEvent.change(screen.getByLabelText("Адрес"), { target: { value: "db.example.test" } });
    fireEvent.change(screen.getByLabelText("Способ входа"), { target: { value: "password" } });
    fireEvent.change(screen.getByLabelText("Пароль для сохранения в Связке ключей"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  };

  it("saves the connection first, then its password under the new connection's id; the password is not in the connection", async () => {
    const save = vi.fn(async () => ({ ref: "cred-1" }));
    const { bus, api, changed } = setup({ save });
    api.save.mockResolvedValue(stored({ id: "new-id", name: "db" }));
    fillNew(bus);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ profileId: "new-id", secret: "s3cret" }));
    expect(JSON.stringify(api.save.mock.calls[0])).not.toContain("s3cret");
    await waitFor(() => expect(screen.queryByTestId("hub-screen")).toBeNull());
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("a password that could not be saved keeps the editor open and says the connection was saved without it", async () => {
    const save = vi.fn(async () => {
      throw new Error("keychain_denied: no");
    });
    const { bus, api } = setup({ save });
    api.save.mockResolvedValue(stored({ id: "new-id", name: "db" }));
    fillNew(bus);
    expect(await screen.findByText("Подключение сохранено, пароль — нет: Связка ключей отказала в доступе к сохранённому паролю.")).toBeTruthy();
    expect(screen.getByTestId("hub-screen")).toBeTruthy();
  });
});
