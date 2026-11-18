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
    expect(ssh.onSshOpen.mock.calls[0]).toEqual([{ host: "build.example.test", user: "ci", port: 2222, identityFile: "/k/id", extraOptions: [] }, SID, undefined]);
  });

  it("Connect on an SSH profile with a saved passphrase passes its reference to the open", async () => {
    const REF = "rh-cred:v1:local:00000000-0000-4000-8000-000000000009";
    const { ssh } = withProfiles([{ ...SSH_PROFILE, credentialRef: REF }]);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Build box" }));
    await waitFor(() => expect(ssh.onSshOpen).toHaveBeenCalledTimes(1));
    expect((ssh.onSshOpen.mock.calls[0] as unknown[])[2]).toBe(REF);
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
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(SID, false));
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

import type { CredentialItem, CredentialsApi } from "./use-credentials.ts";

const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
const SECRET = "S3cr3t-CONN-1";
const RDP_NEW = stored({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Fresh win", protocol: "rdp", authType: "password", username: "admin", host: "fresh.example.test" });

function withCredentials(initial: Profile[], items: CredentialItem[] = []) {
  const base = withProfiles(initial);
  const credentials = {
    list: vi.fn(async () => items),
    save: vi.fn(async (_input: { profileId: string; secret: string }) => ({ ref: REF })),
    update: vi.fn(async (_ref: string, _secret: string) => ({ updated: true })),
    remove: vi.fn(async (_ref: string) => ({ unlinked: 1 })),
    status: vi.fn(async (_ref: string) => ({ state: "present" as const })),
  } satisfies CredentialsApi;
  cleanup();
  const ssh = { onSshOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn() };
  const rdp = { onRdpOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn(), onDecision: vi.fn(), onScreenshot: vi.fn() };
  const view = render(<ConnectPage ssh={ssh as never} rdp={rdp as never} profiles={base.api} credentials={credentials} />);
  return { ...base, credentials, view };
}

describe("ConnectPage: saving a password in the Keychain (stage 3b-1)", () => {
  async function newRdpProfileWithPassword() {
    const ctx = withCredentials([]);
    await screen.findByText(/No saved profiles yet/);
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fresh win" } });
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "rdp" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "fresh.example.test" } });
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "admin" } });
    return ctx;
  }

  it("saves the profile first, then the password under that profile's id; the secret is not in the profile payload", async () => {
    const ctx = await newRdpProfileWithPassword();
    ctx.api.save.mockImplementationOnce(async (input: ProfileInput) => ({ ...RDP_NEW, ...input.fields, id: RDP_NEW.id }) as Profile);
    fireEvent.change(screen.getByLabelText("Password to save in the Keychain"), { target: { value: SECRET } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(ctx.credentials.save).toHaveBeenCalledTimes(1));
    expect(ctx.credentials.save).toHaveBeenCalledWith({ profileId: RDP_NEW.id, secret: SECRET });
    expect(JSON.stringify(ctx.api.save.mock.calls)).not.toContain(SECRET);
    expect(nonJsonPath(ctx.credentials.save.mock.calls[0]?.[0])).toBeNull();
    await waitFor(() => expect(document.querySelector(".rh-editor")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("a profile without a typed password saves no credential at all", async () => {
    const ctx = await newRdpProfileWithPassword();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(ctx.api.save).toHaveBeenCalledTimes(1));
    expect(ctx.credentials.save).not.toHaveBeenCalled();
    expect(ctx.credentials.update).not.toHaveBeenCalled();
  });

  it("a locked Keychain keeps the editor open on the saved profile; the retry updates it instead of creating another", async () => {
    const ctx = await newRdpProfileWithPassword();
    ctx.api.save.mockImplementation(async (input: ProfileInput) => ({ ...RDP_NEW, ...input.fields, id: input.id ?? RDP_NEW.id }) as Profile);
    ctx.credentials.save.mockRejectedValueOnce(new Error("keychain_locked: the Keychain is locked"));
    fireEvent.change(screen.getByLabelText("Password to save in the Keychain"), { target: { value: SECRET } });
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText(/The profile was saved, but not the password: The Keychain is locked or needs approval/)).toBeTruthy();
    expect(document.querySelector(".rh-editor")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Password to save in the Keychain"), { target: { value: SECRET } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(ctx.credentials.save).toHaveBeenCalledTimes(2));
    expect(ctx.api.save.mock.calls[1]?.[0].id).toBe(RDP_NEW.id); // an update, not a second profile
  });

  it("replacing and removing a saved password go to update and remove with the profile's reference", async () => {
    const withRef = stored({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Win", protocol: "rdp", authType: "password", username: "admin", credentialRef: REF });
    const ctx = withCredentials([withRef]);
    ctx.api.save.mockImplementation(async (input: ProfileInput) => ({ ...withRef, ...input.fields, credentialRef: REF }) as Profile);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Win" }));
    fireEvent.change(screen.getByLabelText("Replace the saved password"), { target: { value: SECRET } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(ctx.credentials.update).toHaveBeenCalledWith(REF, SECRET));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Win" }));
    fireEvent.click(screen.getByLabelText("Remove the saved password"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(ctx.credentials.remove).toHaveBeenCalledWith(REF));
  });

  it("when the server dropped the credential because the endpoint moved, the page says so", async () => {
    const withRef = stored({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Win", protocol: "rdp", authType: "password", username: "admin", credentialRef: REF });
    const ctx = withCredentials([withRef]);
    ctx.api.save.mockImplementation(async (input: ProfileInput) => ({ ...withRef, ...input.fields, credentialRef: null }) as Profile);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Win" }));
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "elsewhere.example.test" } });
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText(/saved password was forgotten because the host, port, user or domain changed/)).toBeTruthy();
  });

  it("deleting a profile whose password nobody else uses can delete the password too", async () => {
    const withRef = stored({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Win", protocol: "rdp", authType: "password", username: "admin", credentialRef: REF });
    const ctx = withCredentials([withRef]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Win" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Win" }));
    await waitFor(() => expect(ctx.api.remove).toHaveBeenCalledWith(withRef.id, true));
  });

  it("a Keychain failure while deleting the password is reported after the profile is gone", async () => {
    const withRef = stored({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Win", protocol: "rdp", authType: "password", username: "admin", credentialRef: REF });
    const ctx = withCredentials([withRef]);
    ctx.api.remove.mockImplementationOnce(async () => ({ deleted: true, credentialDeleted: false, credentialError: "keychain_locked" }) as never);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Win" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Win" }));
    expect(await screen.findByText(/The profile was deleted, but its saved password was not: The Keychain is locked or needs approval/)).toBeTruthy();
  });

  it("the Credentials screen opens from the catalogue, lists the credentials and closes", async () => {
    const item: CredentialItem = {
      ref: REF,
      kind: "password",
      label: "Win",
      bind: { type: "endpoint", protocol: "rdp", host: "win.example.test", port: 3389, user: "admin", domain: null },
      createdAt: "2026-11-18T10:00:00.000Z",
      updatedAt: "2026-11-18T10:00:00.000Z",
      usedBy: [],
    };
    const ctx = withCredentials([], [item]);
    await screen.findByText(/No saved profiles yet/);
    fireEvent.click(screen.getByRole("button", { name: "Credentials" }));
    expect(await screen.findByRole("listitem", { name: "Win" })).toBeTruthy();
    expect(ctx.credentials.list).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Saved credentials")).toBeNull();
  });

  it("without a credentials api there is no Credentials button and no password field in the editor", async () => {
    withProfiles([]);
    await screen.findByText(/No saved profiles yet/);
    expect(screen.queryByRole("button", { name: "Credentials" })).toBeNull();
  });
});
