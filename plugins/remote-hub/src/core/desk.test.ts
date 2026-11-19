import { describe, expect, it } from "vitest";
import { closeSession, emptyDesk, focusSession, openSession, patchSession, setLayout, syncGroup, targetKey, type DeskSession, type DeskState } from "./desk.ts";

const P = "5b568675-f842-4a96-83e0-78ae53d96024";

function lxc(id: string, vmid: number, title: string): DeskSession {
  return { id, kind: "pve-terminal", title, detail: `LXC ${vmid}`, target: { type: "pve", profileId: P, console: "lxc", vmid }, state: "connecting", owner: "human", attempt: 0, reason: null };
}

function opened(...sessions: DeskSession[]): DeskState {
  return sessions.reduce((state, s) => openSession(state, s), emptyDesk());
}

describe("targetKey", () => {
  it("names a Proxmox guest by connection, console kind and VMID, and a node shell by its node", () => {
    expect(targetKey({ type: "pve", profileId: P, console: "lxc", vmid: 165 })).toBe(`pve:${P}:lxc:165`);
    expect(targetKey({ type: "pve", profileId: P, console: "node", node: "pve" })).toBe(`pve:${P}:node:pve`);
    expect(targetKey({ type: "profile", profileId: "abc" })).toBe("profile:abc");
  });
});

describe("openSession", () => {
  it("shows and focuses the first session", () => {
    const state = opened(lxc("a", 165, "rdp-ssh-test"));
    expect(state.sessions.map((s) => s.id)).toEqual(["a"]);
    expect(state.shown).toEqual(["a"]);
    expect(state.focus).toBe("a");
  });

  it("in the one-pane layout a new session replaces the shown one and the old one stays open", () => {
    const state = opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db"));
    expect(state.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(state.shown).toEqual(["b"]);
    expect(state.focus).toBe("b");
  });

  it("opening a target that is already open focuses it instead of adding a second session", () => {
    const state = openSession(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db")), lxc("c", 165, "rdp-ssh-test"));
    expect(state.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(state.shown).toEqual(["a"]);
    expect(state.focus).toBe("a");
  });
});

describe("two panes", () => {
  it("switching to two panes adds the most recently opened other session beside the focused one", () => {
    const state = setLayout(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db"), lxc("c", 112, "nginx-ui")), "two");
    expect(state.layout).toBe("two");
    expect(state.shown).toEqual(["c", "b"]);
    expect(state.focus).toBe("c");
  });

  it("with a single session two panes show just that one", () => {
    expect(setLayout(opened(lxc("a", 165, "rdp-ssh-test")), "two").shown).toEqual(["a"]);
  });

  it("focusing a hidden session replaces the pane you are not working in", () => {
    const two = setLayout(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db"), lxc("c", 112, "nginx-ui")), "two");
    const state = focusSession(two, "a");
    expect(state.shown).toEqual(["c", "a"]);
    expect(state.focus).toBe("a");
  });

  it("focusing a shown session only moves the focus", () => {
    const two = setLayout(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db"), lxc("c", 112, "nginx-ui")), "two");
    const state = focusSession(two, "b");
    expect(state.shown).toEqual(["c", "b"]);
    expect(state.focus).toBe("b");
  });

  it("a new session in two panes takes the pane that is not focused", () => {
    const two = setLayout(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db")), "two");
    const state = openSession(two, lxc("c", 112, "nginx-ui"));
    expect(two.shown).toEqual(["b", "a"]);
    expect(state.shown).toEqual(["b", "c"]);
    expect(state.focus).toBe("c");
  });

  it("going back to one pane keeps the focused session", () => {
    const two = focusSession(setLayout(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db")), "two"), "a");
    const state = setLayout(two, "one");
    expect(state.shown).toEqual(["a"]);
    expect(state.focus).toBe("a");
  });
});

describe("closeSession", () => {
  it("closing the shown session shows the one opened just before it", () => {
    const state = closeSession(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db"), lxc("c", 112, "nginx-ui")), "c");
    expect(state.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(state.shown).toEqual(["b"]);
    expect(state.focus).toBe("b");
  });

  it("closing a hidden session changes nothing on screen", () => {
    const state = closeSession(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db")), "a");
    expect(state.sessions.map((s) => s.id)).toEqual(["b"]);
    expect(state.shown).toEqual(["b"]);
    expect(state.focus).toBe("b");
  });

  it("closing the last session leaves an empty desk", () => {
    const state = closeSession(opened(lxc("a", 165, "rdp-ssh-test")), "a");
    expect(state.sessions).toEqual([]);
    expect(state.shown).toEqual([]);
    expect(state.focus).toBeNull();
  });

  it("in two panes the freed pane is filled by a hidden session when there is one", () => {
    const two = setLayout(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db"), lxc("c", 112, "nginx-ui")), "two");
    const state = closeSession(two, "b");
    expect(state.shown).toEqual(["c", "a"]);
    expect(state.focus).toBe("c");
  });

  it("an unknown id is ignored", () => {
    const before = opened(lxc("a", 165, "rdp-ssh-test"));
    expect(closeSession(before, "zzz")).toBe(before);
  });
});

describe("patchSession", () => {
  it("changes only the named session", () => {
    const state = patchSession(opened(lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db")), "a", { state: "reconnecting", attempt: 2 });
    expect(state.sessions.map((s) => [s.id, s.state, s.attempt])).toEqual([
      ["a", "reconnecting", 2],
      ["b", "connecting", 0],
    ]);
  });

  it("an unknown id is ignored", () => {
    const before = opened(lxc("a", 165, "rdp-ssh-test"));
    expect(patchSession(before, "zzz", { state: "active" })).toBe(before);
  });
});

describe("syncGroup", () => {
  const isPve = (s: DeskSession): boolean => s.target.type === "pve";
  const ssh: DeskSession = { id: "s", kind: "ssh", title: "win-test", detail: "admin@10.0.0.5", target: { type: "profile", profileId: "abc" }, state: "active", owner: "human", attempt: 0, reason: null };

  it("adds the group's new sessions, shows the newest and leaves other sessions alone", () => {
    const state = syncGroup(opened(ssh), isPve, [lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db")]);
    expect(state.sessions.map((s) => s.id)).toEqual(["s", "a", "b"]);
    expect(state.shown).toEqual(["b"]);
    expect(state.focus).toBe("b");
  });

  it("updates a session that is still there without moving it or the focus", () => {
    const before = focusSession(opened(lxc("a", 165, "rdp-ssh-test"), ssh), "s");
    const state = syncGroup(before, isPve, [{ ...lxc("a", 165, "rdp-ssh-test"), state: "lost", reason: "The console was lost." }]);
    expect(state.sessions.map((s) => [s.id, s.state])).toEqual([
      ["a", "lost"],
      ["s", "active"],
    ]);
    expect(state.shown).toEqual(["s"]);
    expect(state.focus).toBe("s");
  });

  it("removes the group's sessions that are gone, as if they were closed", () => {
    const state = syncGroup(opened(ssh, lxc("a", 165, "rdp-ssh-test"), lxc("b", 110, "db")), isPve, [lxc("a", 165, "rdp-ssh-test")]);
    expect(state.sessions.map((s) => s.id)).toEqual(["s", "a"]);
    expect(state.shown).toEqual(["a"]);
    expect(state.focus).toBe("a");
  });

  it("returns the same state when nothing differs", () => {
    const before = opened(ssh, lxc("a", 165, "rdp-ssh-test"));
    expect(syncGroup(before, isPve, [lxc("a", 165, "rdp-ssh-test")])).toBe(before);
  });
});
