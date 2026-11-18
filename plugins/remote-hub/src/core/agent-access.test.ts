import { describe, expect, it, vi } from "vitest";
import { AgentAccessBook, type AgentGrant, type AgentGrantStore } from "./agent-access.ts";

const P1 = "11111111-2222-4333-8444-555555555551";
const P2 = "11111111-2222-4333-8444-555555555552";

function setup(existing: string[] = [P1, P2]) {
  const rows = new Map<string, AgentGrant>();
  const store: AgentGrantStore = {
    all: () => [...rows.values()],
    get: (id) => rows.get(id) ?? null,
    put: (g) => void rows.set(g.profileId, g),
    remove: (id) => rows.delete(id),
    clear: () => {
      const n = rows.size;
      rows.clear();
      return n;
    },
  };
  const alive = new Set(existing);
  const changed = vi.fn();
  const book = new AgentAccessBook({ store, profiles: { has: (id) => alive.has(id) }, now: () => new Date("2026-11-18T12:00:00.000Z") });
  book.onChange(changed);
  return { book, rows, alive, changed };
}

describe("agent access levels", () => {
  it("every profile starts at none: nothing is allowed", () => {
    const { book } = setup();
    for (const action of ["observe", "connect", "input", "exec"] as const) {
      expect(book.check(P1, action)).toEqual({ ok: false, code: "agent_access_denied" });
    }
  });

  it("levels are ordered none < observe < input < exec, and connect is allowed from input up", () => {
    const { book } = setup();
    const allowed = (level: "none" | "observe" | "input" | "exec") => {
      book.set(P1, level, false);
      return (["observe", "connect", "input", "exec"] as const).filter((a) => book.check(P1, a).ok);
    };
    expect(allowed("none")).toEqual([]);
    expect(allowed("observe")).toEqual(["observe"]);
    expect(allowed("input")).toEqual(["observe", "connect", "input"]);
    expect(allowed("exec")).toEqual(["observe", "connect", "input", "exec"]);
  });

  it("a grant is for one profile only", () => {
    const { book } = setup();
    book.set(P1, "exec", false);
    expect(book.check(P2, "observe")).toEqual({ ok: false, code: "agent_access_denied" });
  });

  it("an unknown or deleted profile is denied with the same code, and cannot be granted", () => {
    const { book, alive } = setup();
    expect(() => book.set("99999999-2222-4333-8444-555555555559", "observe", false)).toThrow(/profile_not_found/);
    book.set(P1, "observe", false);
    alive.delete(P1);
    expect(book.check(P1, "observe")).toEqual({ ok: false, code: "agent_access_denied" });
    expect(book.list()).toEqual([]);
  });

  it("recording commands is remembered only for exec", () => {
    const { book } = setup();
    expect(book.set(P1, "exec", true)).toMatchObject({ level: "exec", recordCommands: true });
    expect(book.set(P1, "input", true)).toMatchObject({ level: "input", recordCommands: false });
    expect(book.get(P1)).toMatchObject({ level: "input", recordCommands: false });
  });

  it("none removes the row; get then reports none", () => {
    const { book, rows } = setup();
    book.set(P1, "observe", false);
    book.set(P1, "none", false);
    expect(rows.size).toBe(0);
    expect(book.get(P1)).toMatchObject({ level: "none", recordCommands: false });
  });

  it("revoke all removes every grant, tells listeners, and the next check is denied", () => {
    const { book, changed } = setup();
    book.set(P1, "exec", false);
    book.set(P2, "observe", false);
    changed.mockClear();
    expect(book.revokeAll()).toBe(2);
    expect(book.check(P1, "observe").ok).toBe(false);
    expect(book.list()).toEqual([]);
    expect(changed).toHaveBeenCalledWith({ profileId: null, level: "none" });
  });

  it("lowering a grant tells listeners with the profile and the new level", () => {
    const { book, changed } = setup();
    book.set(P1, "exec", false);
    book.set(P1, "observe", false);
    expect(changed).toHaveBeenLastCalledWith({ profileId: P1, level: "observe" });
  });

  it("refuses a level that is not one of the four", () => {
    const { book } = setup();
    expect(() => book.set(P1, "admin" as never, false)).toThrow(/invalid_level/);
  });
});
