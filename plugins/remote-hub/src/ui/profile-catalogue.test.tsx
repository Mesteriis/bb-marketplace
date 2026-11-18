// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../core/profile.ts";
import type { SessionInfo } from "../core/rpc.ts";
import { ProfileCatalogue, type ProfileCatalogueProps } from "./profile-catalogue.tsx";

afterEach(cleanup);

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function profile(over: Partial<Profile> & { id: string; name: string }): Profile {
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

const PROFILES = [
  profile({ id: A, name: "Build box", group: "Lab", host: "build.example.test", username: "ci", port: 2222 }),
  profile({ id: B, name: "alpha", group: "Lab", favorite: true }),
  profile({ id: C, name: "Windows", protocol: "rdp", authType: "password", username: "admin", host: "win.example.test" }),
];

function mount(over: Partial<ProfileCatalogueProps> = {}) {
  const handlers = { onConnect: vi.fn(), onEdit: vi.fn(), onNew: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() };
  render(<ProfileCatalogue profiles={PROFILES} error={null} sessions={[]} {...handlers} {...over} />);
  return handlers;
}

describe("ProfileCatalogue", () => {
  it("lists groups with the ungrouped last, favourites first, and the endpoint of each profile", () => {
    mount();
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Lab", "Ungrouped"]);
    const lab = within(screen.getByRole("group", { name: "Lab" })).getAllByRole("listitem");
    expect(lab.map((li) => within(li).getByTestId("profile-name").textContent)).toEqual(["alpha", "Build box"]);
    expect(within(lab[1] as HTMLElement).getByText("ci@build.example.test:2222")).toBeTruthy();
  });

  it("search narrows the list and says so when nothing matches", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Search profiles"), { target: { value: "win" } });
    expect(screen.getAllByTestId("profile-name").map((n) => n.textContent)).toEqual(["Windows"]);
    fireEvent.change(screen.getByLabelText("Search profiles"), { target: { value: "zzz" } });
    expect(screen.getByText("No profile matches.")).toBeTruthy();
  });

  it("the protocol and favourites filters apply", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "RDP" }));
    expect(screen.getAllByTestId("profile-name").map((n) => n.textContent)).toEqual(["Windows"]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getAllByTestId("profile-name").map((n) => n.textContent)).toEqual(["alpha"]);
  });

  it("shows the status derived from sessions: open, connecting, and idle", () => {
    const sessions = [
      { generation: "0".repeat(32), sessionId: 1, kind: "ssh", state: "running", exitCode: null, signal: null, reason: null, profileId: A },
      { generation: "0".repeat(32), sessionId: 2, kind: "ssh", state: "running", exitCode: null, signal: null, reason: null, profileId: A },
      {
        generation: "0".repeat(32),
        sessionId: 3,
        kind: "rdp",
        state: "connecting",
        exitCode: null,
        signal: null,
        reason: null,
        profileId: C,
        rdp: { target: { host: "h", port: 3389, username: "u", domain: null }, state: "tls", prompt: null, desktop: null, trace: [] },
      },
    ] as SessionInfo[];
    mount({ sessions });
    const status = (name: string) => within(screen.getByRole("listitem", { name })).getByTestId("profile-status").textContent;
    expect(status("Build box")).toBe("open ×2");
    expect(status("Windows")).toBe("connecting");
    expect(status("alpha")).toBe("");
  });

  it("Connect, Edit and Duplicate call back with the profile; New has its own button", () => {
    const h = mount();
    fireEvent.click(screen.getByRole("button", { name: "Connect Build box" }));
    expect(h.onConnect).toHaveBeenCalledWith(PROFILES[0]);
    fireEvent.click(screen.getByRole("button", { name: "Edit Build box" }));
    expect(h.onEdit).toHaveBeenCalledWith(PROFILES[0]);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Build box" }));
    expect(h.onDuplicate).toHaveBeenCalledWith(PROFILES[0]);
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    expect(h.onNew).toHaveBeenCalledTimes(1);
  });

  it("Delete asks first: nothing is deleted until it is confirmed, and Cancel backs out", () => {
    const h = mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete Build box" }));
    expect(h.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel delete Build box" }));
    expect(screen.queryByRole("button", { name: "Confirm delete Build box" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete Build box" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Build box" }));
    expect(h.onDelete).toHaveBeenCalledWith(PROFILES[0], false);
  });

  it("has loading, error (with Retry) and empty states", () => {
    cleanup();
    const loading = mount({ profiles: null });
    expect(screen.getByText("Loading profiles…")).toBeTruthy();
    expect(loading.onRetry).not.toHaveBeenCalled();
    cleanup();
    const failing = mount({ profiles: null, error: "storage unavailable" });
    expect(screen.getByText("storage unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(failing.onRetry).toHaveBeenCalledTimes(1);
    cleanup();
    mount({ profiles: [] });
    expect(screen.getByText(/No saved profiles yet/)).toBeTruthy();
  });

  it("shows the last failure code of an open, never a message", () => {
    mount({ profiles: [profile({ id: A, name: "Flaky", recentErrors: [{ at: "2026-11-18T10:00:00.000Z", code: "not_found" }] })] });
    expect(screen.getByText("last open failed: not_found")).toBeTruthy();
  });
});

describe("ProfileCatalogue and saved passwords (stage 3b-1)", () => {
  const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
  const WITH = profile({ id: A, name: "Win", protocol: "rdp", authType: "password", username: "u", credentialRef: REF });
  const TWIN = profile({ id: B, name: "Win twin", protocol: "rdp", authType: "password", username: "u", credentialRef: REF });
  const ALONE = profile({ id: C, name: "Solo", protocol: "rdp", authType: "password", username: "u", credentialRef: "rh-cred:v1:local:11111111-2222-4333-8444-555555555555" });

  it("marks a profile that has a saved password", () => {
    mount({ profiles: [WITH, profile({ id: C, name: "Plain" })] });
    expect(within(screen.getByRole("listitem", { name: "Win" })).getByText("saved password")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "Plain" })).queryByText("saved password")).toBeNull();
  });

  it("deleting a profile whose password nobody else uses asks whether to delete it too (default yes)", () => {
    const h = mount({ profiles: [ALONE] });
    fireEvent.click(screen.getByRole("button", { name: "Delete Solo" }));
    const box = screen.getByLabelText("Also delete the saved password") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Solo" }));
    expect(h.onDelete).toHaveBeenCalledWith(ALONE, true);
  });

  it("the choice can be turned off, and then the password is kept", () => {
    const h = mount({ profiles: [ALONE] });
    fireEvent.click(screen.getByRole("button", { name: "Delete Solo" }));
    fireEvent.click(screen.getByLabelText("Also delete the saved password"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Solo" }));
    expect(h.onDelete).toHaveBeenCalledWith(ALONE, false);
  });

  it("when another profile shares the password there is no question: it stays, and the screen says so", () => {
    const h = mount({ profiles: [WITH, TWIN] });
    fireEvent.click(screen.getByRole("button", { name: "Delete Win" }));
    expect(screen.queryByLabelText("Also delete the saved password")).toBeNull();
    expect(screen.getByText(/Win twin still uses the saved password/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Win" }));
    expect(h.onDelete).toHaveBeenCalledWith(WITH, false);
  });

  it("offers Credentials only when the screen exists", () => {
    const onShowCredentials = vi.fn();
    mount({ onShowCredentials });
    fireEvent.click(screen.getByRole("button", { name: "Credentials" }));
    expect(onShowCredentials).toHaveBeenCalledTimes(1);
    cleanup();
    mount();
    expect(screen.queryByRole("button", { name: "Credentials" })).toBeNull();
  });
});
