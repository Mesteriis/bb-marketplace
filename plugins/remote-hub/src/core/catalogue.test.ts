import { describe, expect, it } from "vitest";
import { filterProfiles, groupProfiles, profileStatus, profileToRdpForm, profileToSshTarget } from "./catalogue.ts";
import type { Profile } from "./profile.ts";
import type { SessionInfo } from "./rpc.ts";

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

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const SET: Profile[] = [
  profile({ id: A, name: "Build box", group: "Lab", host: "build.example.test", username: "ci", tags: ["linux", "ci"] }),
  profile({ id: B, name: "alpha", group: "Lab", favorite: true, host: "10.0.0.5" }),
  profile({ id: C, name: "Windows jump", protocol: "rdp", authType: "password", username: "admin", domain: "CORP", host: "win.example.test", rdpWidth: 1920, rdpHeight: 1080 }),
  profile({ id: D, name: "Zed", group: "Archive", host: "z.example.test" }),
];

describe("filterProfiles", () => {
  it("matches name, host, user, group and tags case-insensitively", () => {
    const ids = (query: string) => filterProfiles(SET, { query, protocol: "all", favoritesOnly: false }).map((p) => p.id);
    expect(ids("BUILD")).toEqual([A]);
    expect(ids("10.0.0")).toEqual([B]);
    expect(ids("admin")).toEqual([C]);
    expect(ids("archive")).toEqual([D]);
    expect(ids("ci")).toEqual([A]);
    expect(ids("")).toEqual([A, B, C, D]);
    expect(ids("nothing-matches")).toEqual([]);
  });

  it("filters by protocol and by favourites", () => {
    expect(filterProfiles(SET, { query: "", protocol: "rdp", favoritesOnly: false }).map((p) => p.id)).toEqual([C]);
    expect(filterProfiles(SET, { query: "", protocol: "ssh", favoritesOnly: false }).map((p) => p.id)).toEqual([A, B, D]);
    expect(filterProfiles(SET, { query: "", protocol: "all", favoritesOnly: true }).map((p) => p.id)).toEqual([B]);
  });
});

describe("groupProfiles", () => {
  it("sorts groups by name with the ungrouped last, favourites first inside a group, then by name", () => {
    const groups = groupProfiles(SET);
    expect(groups.map((g) => g.group)).toEqual(["Archive", "Lab", null]);
    expect(groups[1]?.profiles.map((p) => p.name)).toEqual(["alpha", "Build box"]);
    expect(groups[2]?.profiles.map((p) => p.name)).toEqual(["Windows jump"]);
  });
});

function session(over: Partial<SessionInfo> & { profileId?: string }): SessionInfo {
  return {
    generation: "0".repeat(32),
    sessionId: 1,
    kind: "ssh",
    state: "running",
    exitCode: null,
    signal: null,
    reason: null,
    ...over,
  } as SessionInfo;
}

describe("profileStatus", () => {
  it("is idle with no session of the profile, and ignores other profiles and closed sessions", () => {
    expect(profileStatus(A, [])).toEqual({ state: "idle", sessions: 0 });
    expect(profileStatus(A, [session({ profileId: B }), session({ profileId: A, state: "closed" }), session({})])).toEqual({ state: "idle", sessions: 0 });
  });

  it("is open for a running SSH session and counts several sessions of one profile", () => {
    expect(profileStatus(A, [session({ profileId: A }), session({ profileId: A, sessionId: 2 })])).toEqual({ state: "open", sessions: 2 });
  });

  it("an RDP session is connecting until the desktop is ready", () => {
    const rdp = (state: "connecting" | "cert_prompt" | "desktop_ready") =>
      session({
        profileId: C,
        kind: "rdp",
        state: "connecting",
        rdp: { target: { host: "h", port: 3389, username: "u", domain: null }, state, prompt: null, desktop: null, trace: [] },
      });
    expect(profileStatus(C, [rdp("cert_prompt")])).toEqual({ state: "connecting", sessions: 1 });
    expect(profileStatus(C, [rdp("desktop_ready")])).toEqual({ state: "open", sessions: 1 });
  });
});

describe("opening a profile", () => {
  it("builds the SSH target: user, port and key only for key auth, never an option", () => {
    expect(profileToSshTarget(profile({ id: A, name: "x", host: "h.example.test", username: "ci", port: 2222, authType: "key", identityFile: "/k/id" }))).toEqual({
      host: "h.example.test",
      user: "ci",
      port: 2222,
      identityFile: "/k/id",
      extraOptions: [],
    });
    expect(profileToSshTarget(profile({ id: A, name: "x", host: "h.example.test" }))).toEqual({ host: "h.example.test", extraOptions: [] });
  });

  it("builds the RDP form values with the protocol defaults", () => {
    expect(profileToRdpForm(SET[2] as Profile)).toEqual({ host: "win.example.test", port: 3389, username: "admin", domain: "CORP", width: 1920, height: 1080 });
    expect(profileToRdpForm(profile({ id: A, name: "x", protocol: "rdp", authType: "password", username: "u" }))).toEqual({
      host: "h.example.test",
      port: 3389,
      username: "u",
      domain: null,
      width: null,
      height: null,
    });
  });
});
