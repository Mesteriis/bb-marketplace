// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

import { ConnectPage } from "./connect-page.tsx";

afterEach(cleanup);

function page(initialKind?: "ssh" | "rdp") {
  const ssh = { onSshOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn() };
  const rdp = { onRdpOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn(), onDecision: vi.fn(), onScreenshot: vi.fn() };
  return render(<ConnectPage ssh={ssh as never} rdp={rdp as never} initialKind={initialKind} />);
}

describe("ConnectPage", () => {
  it("shows SSH first, with the kind switch pressed accordingly", () => {
    const { container } = page();
    expect(screen.getByText("SSH").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("RDP").getAttribute("aria-pressed")).toBe("false");
    const panes = container.querySelectorAll(".rh-kind-pane");
    expect((panes[0] as HTMLElement).hidden).toBe(false);
    expect((panes[1] as HTMLElement).hidden).toBe(true);
  });

  it("switching to RDP shows the RDP form (password field included) and keeps the SSH page mounted", () => {
    const { container } = page();
    fireEvent.click(screen.getByText("RDP"));
    const panes = container.querySelectorAll(".rh-kind-pane");
    expect((panes[0] as HTMLElement).hidden).toBe(true);
    expect((panes[1] as HTMLElement).hidden).toBe(false);
    expect(container.querySelector('input[type="password"]')).toBeTruthy();
    expect(container.querySelector('input[placeholder="host"]')).toBeTruthy(); // the SSH form is still there
    expect(screen.getByText("RDP").getAttribute("aria-pressed")).toBe("true");
  });

  it("can start on RDP", () => {
    const { container } = page("rdp");
    expect((container.querySelectorAll(".rh-kind-pane")[1] as HTMLElement).hidden).toBe(false);
  });
});

import { waitFor } from "@testing-library/react";
import { nonJsonPath } from "../core/json-wire.ts";
import type { Profile, ProfileInput } from "../core/profile.ts";
import type { ProfilesApi } from "./use-profiles.ts";

const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function stored(over: Partial<Profile> & { id: string; name: string }): Profile {
  return {
    executionHostId: "local",
    origin: "manual",
    createdAt: "2026-11-18T10:00:00.000Z",
    updatedAt: "2026-11-18T10:00:00.000Z",
    lastOpenedAt: null,
    recentErrors: [],
    protocol: "ssh",
    group: null,
    tags: [],
    favorite: false,
    color: null,
    host: "h.example.test",
    port: null,
    username: null,
    domain: null,
    authType: "agent",
    identityFile: null,
    credentialRef: null,
    rdpWidth: null,
    rdpHeight: null,
    ...over,
  } as Profile;
}

const SSH_PROFILE = stored({ id: SID, name: "Build box", host: "build.example.test", username: "ci", port: 2222, authType: "key", identityFile: "/k/id" });
const RDP_PROFILE = stored({ id: RID, name: "Windows", protocol: "rdp", authType: "password", username: "admin", domain: "CORP", host: "win.example.test", rdpWidth: 1920, rdpHeight: 1080 });

function withProfiles(initial: Profile[]) {
  let rows = [...initial];
  const api = {
    list: vi.fn(async () => rows),
    save: vi.fn(async (input: ProfileInput) => {
      const saved = stored({ ...input.fields, id: input.id ?? "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } as Profile);
      rows = [...rows.filter((r) => r.id !== saved.id), saved];
      return saved;
    }),
    remove: vi.fn(async (id: string) => {
      rows = rows.filter((r) => r.id !== id);
      return { deleted: true };
    }),
    duplicate: vi.fn(async (id: string) => stored({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "copy", ...rows.find((r) => r.id === id) } as Profile)),
    sessions: vi.fn(async () => []),
  } satisfies ProfilesApi;
  const ssh = { onSshOpen: vi.fn(async () => ({ generation: "a".repeat(32), sessionId: 1 })), onAttach: vi.fn(async () => Promise.reject(new Error("no terminal in this test"))), onClose: vi.fn(async () => {}) };
  const rdp = { onRdpOpen: vi.fn(async () => ({ generation: "a".repeat(32), sessionId: 2 })), onAttach: vi.fn(), onClose: vi.fn(), onDecision: vi.fn(), onScreenshot: vi.fn() };
  const view = render(<ConnectPage ssh={ssh as never} rdp={rdp as never} profiles={api} />);
  return { api, ssh, rdp, view };
}

describe("ConnectPage with saved profiles", () => {
  it("loads the catalogue and keeps Quick connect beside it", async () => {
    withProfiles([SSH_PROFILE]);
    expect(await screen.findByText("Build box")).toBeTruthy();
    expect(screen.getByText("Quick connect")).toBeTruthy();
    expect(screen.getByLabelText("Search profiles")).toBeTruthy();
  });

  it("Connect on an SSH profile opens it with the profile id and its key file", async () => {
    const { ssh } = withProfiles([SSH_PROFILE]);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Build box" }));
    await waitFor(() => expect(ssh.onSshOpen).toHaveBeenCalledTimes(1));
    expect(ssh.onSshOpen.mock.calls[0]).toEqual([{ host: "build.example.test", user: "ci", port: 2222, identityFile: "/k/id", extraOptions: [] }, SID]);
  });

  it("Connect on an RDP profile switches to RDP, fills the form and waits for the password", async () => {
    const { rdp, view } = withProfiles([RDP_PROFILE]);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Windows" }));
    await waitFor(() => expect((view.container.querySelector('input[aria-label="host"]') as HTMLInputElement).value).toBe("win.example.test"));
    expect((view.container.querySelector('input[aria-label="password"]') as HTMLInputElement).value).toBe("");
    expect(rdp.onRdpOpen).not.toHaveBeenCalled();
    const panes = view.container.querySelectorAll(".rh-kind-pane");
    expect((panes[1] as HTMLElement).hidden).toBe(false);
  });

  it("New profile opens the editor, Save stores it and refreshes the list, then Quick connect returns", async () => {
    const { api, view } = withProfiles([]);
    expect(await screen.findByText(/No saved profiles yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "fresh" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "fresh.example.test" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0]?.[0]).toMatchObject({ fields: { name: "fresh", host: "fresh.example.test", protocol: "ssh" } });
    expect(api.save.mock.calls[0]?.[0].id).toBeUndefined();
    // BB's RPC refuses an undefined-valued key (not just a present one): the payload must be strict JSON.
    expect(nonJsonPath(api.save.mock.calls[0]?.[0])).toBeNull();
    expect(await screen.findByText("fresh")).toBeTruthy();
    expect(view.container.querySelector(".rh-editor")).toBeNull();
    expect((view.container.querySelector(".rh-connect-sessions") as HTMLElement).hidden).toBe(false);
  });

  it("Edit saves with the profile's id; Delete (confirmed) removes it", async () => {
    const { api } = withProfiles([SSH_PROFILE]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Build box" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Build box 2" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0]?.[0].id).toBe(SID);
    expect(nonJsonPath(api.save.mock.calls[0]?.[0])).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Build box 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Build box 2" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(SID));
    await waitFor(() => expect(screen.queryByText("Build box 2")).toBeNull());
  });

  it("a failed delete shows its error instead of silently doing nothing", async () => {
    const { api } = withProfiles([SSH_PROFILE]);
    api.remove.mockRejectedValueOnce(new Error("storage is read-only"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Build box" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Build box" }));
    expect(await screen.findByText("storage is read-only")).toBeTruthy();
  });

  it("the profile list API failing shows the error with Retry that reloads", async () => {
    const { api } = withProfiles([SSH_PROFILE]);
    api.list.mockRejectedValueOnce(new Error("storage unavailable"));
    cleanup();
    const ssh = { onSshOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn() };
    const rdp = { onRdpOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn(), onDecision: vi.fn(), onScreenshot: vi.fn() };
    render(<ConnectPage ssh={ssh as never} rdp={rdp as never} profiles={api} />);
    expect(await screen.findByText("storage unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Build box")).toBeTruthy();
  });

  it("without a profiles api there is no catalogue and no Quick connect label", () => {
    const ssh = { onSshOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn() };
    const rdp = { onRdpOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn(), onDecision: vi.fn(), onScreenshot: vi.fn() };
    const { container } = render(<ConnectPage ssh={ssh as never} rdp={rdp as never} />);
    expect(container.querySelector(".rh-catalogue")).toBeNull();
    expect(screen.queryByText("Quick connect")).toBeNull();
  });
});
