import { describe, expect, it, vi } from "vitest";
import { ControlLeases, type LeaseEnd } from "./control-lease.ts";

const S1 = "0123456789abcdef0123456789abcdef.1";
const S2 = "0123456789abcdef0123456789abcdef.2";

function setup() {
  let now = 1_000_000;
  let n = 0;
  const ended: LeaseEnd[] = [];
  const leases = new ControlLeases({ now: () => now, newId: () => `lease-${++n}` });
  leases.onEnd((e) => ended.push(e));
  return { leases, ended, advance: (ms: number) => void (now += ms), at: () => now };
}

describe("one owner at a time", () => {
  it("a session starts with the human; an agent acquires it; nobody else can while it is held", () => {
    const { leases } = setup();
    expect(leases.owner(S1)).toEqual({ kind: "human", generation: 0 });
    const a = leases.acquire(S1, "thr_a", 120);
    expect(a).toEqual({ ok: true, leaseId: "lease-1", expiresAt: 1_120_000, generation: 1 });
    expect(leases.owner(S1)).toEqual({ kind: "agent", threadId: "thr_a", leaseId: "lease-1", expiresAt: 1_120_000, generation: 1 });
    expect(leases.acquire(S1, "thr_b", 120)).toEqual({ ok: false, code: "held_by_another_thread" });
    // Another session is independent.
    expect(leases.acquire(S2, "thr_b", 120)).toMatchObject({ ok: true });
  });

  it("the same thread acquiring again with its lease id renews it; without the id it is refused (one lease per thread and session)", () => {
    const { leases, advance } = setup();
    const a = leases.acquire(S1, "thr_a", 60);
    if (!a.ok) throw new Error("acquire");
    advance(30_000);
    expect(leases.acquire(S1, "thr_a", 60)).toEqual({ ok: false, code: "already_held_by_you" });
    expect(leases.renew(S1, "thr_a", a.leaseId, 90)).toEqual({ ok: true, leaseId: a.leaseId, expiresAt: 1_120_000, generation: a.generation });
    expect(leases.renew(S1, "thr_b", a.leaseId, 90)).toEqual({ ok: false, code: "not_the_owner" });
    expect(leases.renew(S1, "thr_a", "wrong", 90)).toEqual({ ok: false, code: "not_the_owner" });
  });

  it("the time to live defaults to 120 s, is capped at 600 s and has a floor of 5 s", () => {
    const { leases, at } = setup();
    expect(leases.acquire(S1, "a")).toMatchObject({ expiresAt: at() + 120_000 });
    expect(leases.acquire(S2, "a", 100_000)).toMatchObject({ expiresAt: at() + 600_000 });
    const { leases: l2, at: at2 } = setup();
    expect(l2.acquire(S1, "a", 1)).toMatchObject({ expiresAt: at2() + 5_000 });
  });
});

describe("how a lease ends", () => {
  it("expiry: input after the time is refused, the owner is the human again, the generation moved on, listeners are told", () => {
    const { leases, ended, advance } = setup();
    const a = leases.acquire(S1, "thr_a", 10);
    if (!a.ok) throw new Error("acquire");
    advance(9_999);
    expect(leases.check(S1, "thr_a", a.leaseId)).toEqual({ ok: true, generation: 1 });
    advance(1);
    expect(leases.check(S1, "thr_a", a.leaseId)).toEqual({ ok: false, code: "lease_expired" });
    expect(leases.owner(S1)).toEqual({ kind: "human", generation: 2 });
    expect(ended).toEqual([{ sessionKey: S1, threadId: "thr_a", leaseId: a.leaseId, reason: "expired", generation: 2 }]);
    // Telling listeners happens once.
    leases.sweep();
    expect(ended).toHaveLength(1);
  });

  it("sweep ends the expired ones without anybody asking", () => {
    const { leases, ended, advance } = setup();
    leases.acquire(S1, "a", 5);
    leases.acquire(S2, "b", 100);
    advance(6_000);
    leases.sweep();
    expect(ended.map((e) => [e.sessionKey, e.reason])).toEqual([[S1, "expired"]]);
    expect(leases.owner(S2)).toMatchObject({ kind: "agent" });
  });

  it("release by the owner; a release by anyone else, or with the wrong id, changes nothing", () => {
    const { leases, ended } = setup();
    const a = leases.acquire(S1, "thr_a", 60);
    if (!a.ok) throw new Error("acquire");
    expect(leases.release(S1, "thr_b", a.leaseId)).toEqual({ ok: false, code: "not_the_owner" });
    expect(leases.release(S1, "thr_a", "wrong")).toEqual({ ok: false, code: "not_the_owner" });
    expect(leases.owner(S1)).toMatchObject({ kind: "agent" });
    expect(leases.release(S1, "thr_a", a.leaseId)).toEqual({ ok: true });
    expect(leases.owner(S1)).toEqual({ kind: "human", generation: 2 });
    expect(ended.map((e) => e.reason)).toEqual(["released"]);
    expect(leases.release(S1, "thr_a", a.leaseId)).toEqual({ ok: false, code: "no_lease" });
  });

  it("the human takes over at once: the lease ends, the generation moves, the old lease id is useless, and the agent can acquire again afterwards", () => {
    const { leases, ended } = setup();
    const a = leases.acquire(S1, "thr_a", 60);
    if (!a.ok) throw new Error("acquire");
    expect(leases.takeover(S1)).toEqual({ ok: true, previous: { threadId: "thr_a", leaseId: a.leaseId } });
    expect(leases.check(S1, "thr_a", a.leaseId)).toEqual({ ok: false, code: "no_lease" });
    expect(leases.owner(S1)).toEqual({ kind: "human", generation: 2 });
    expect(ended).toEqual([{ sessionKey: S1, threadId: "thr_a", leaseId: a.leaseId, reason: "takeover", generation: 2 }]);
    expect(leases.takeover(S1)).toEqual({ ok: true, previous: null }); // nothing to take: idempotent
    expect(leases.acquire(S1, "thr_a", 60)).toMatchObject({ ok: true, generation: 3 });
  });

  it("a thread that is gone, a revoked grant and a closed session end their leases with their own reason", () => {
    const { leases, ended } = setup();
    leases.acquire(S1, "thr_a", 60);
    leases.acquire(S2, "thr_a", 60);
    expect(leases.endForThread("thr_a", "thread_gone")).toBe(2);
    expect(ended.map((e) => e.reason)).toEqual(["thread_gone", "thread_gone"]);
    leases.acquire(S1, "thr_b", 60);
    expect(leases.endSession(S1, "session_closed")).toBe(true);
    leases.acquire(S1, "thr_b", 60);
    expect(leases.endWhere((key) => key === S1, "revoked")).toBe(1);
    expect(ended.map((e) => e.reason).slice(2)).toEqual(["session_closed", "revoked"]);
  });

  it("nothing is restored: a new ControlLeases starts with the human on every session", () => {
    const { leases } = setup();
    leases.acquire(S1, "thr_a", 60);
    const fresh = setup().leases;
    expect(fresh.owner(S1)).toEqual({ kind: "human", generation: 0 });
    expect(fresh.check(S1, "thr_a", "lease-1")).toEqual({ ok: false, code: "no_lease" });
  });
});

describe("check", () => {
  it("is exact: the lease id, the thread and the generation must all match", () => {
    const { leases } = setup();
    const a = leases.acquire(S1, "thr_a", 60);
    if (!a.ok) throw new Error("acquire");
    expect(leases.check(S1, "thr_a", a.leaseId)).toEqual({ ok: true, generation: 1 });
    expect(leases.check(S1, "thr_b", a.leaseId)).toEqual({ ok: false, code: "not_the_owner" });
    expect(leases.check(S1, "thr_a", "other")).toEqual({ ok: false, code: "not_the_owner" });
    expect(leases.check(S2, "thr_a", a.leaseId)).toEqual({ ok: false, code: "no_lease" });
  });

  it("takeover races: a check made just before and just after a takeover disagree, and the generation tells a queued operation which it was", () => {
    const { leases } = setup();
    const a = leases.acquire(S1, "thr_a", 60);
    if (!a.ok) throw new Error("acquire");
    const before = leases.check(S1, "thr_a", a.leaseId);
    leases.takeover(S1);
    const after = leases.check(S1, "thr_a", a.leaseId);
    expect(before).toEqual({ ok: true, generation: 1 });
    expect(after.ok).toBe(false);
    expect(leases.owner(S1).generation).toBe(2);
  });
});

describe("listeners", () => {
  it("a throwing listener does not stop the others or the release", () => {
    const { leases } = setup();
    const second = vi.fn();
    leases.onEnd(() => {
      throw new Error("boom");
    });
    leases.onEnd(second);
    leases.acquire(S1, "a", 60);
    expect(leases.takeover(S1)).toMatchObject({ ok: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(leases.owner(S1).kind).toBe("human");
  });
});

describe("onChange: whoever shows the owner is told after every change of it", () => {
  it("fires for acquire, renew, release, takeover, expiry (on sweep) and forget, with the session key", () => {
    const { leases, advance } = setup();
    const seen: string[] = [];
    leases.onChange((key) => seen.push(key));
    const a = leases.acquire(S1, "thr_a", 60);
    if (!a.ok) throw new Error("acquire");
    leases.renew(S1, "thr_a", a.leaseId, 60);
    leases.release(S1, "thr_a", a.leaseId);
    leases.acquire(S1, "thr_a", 60);
    leases.takeover(S1);
    leases.acquire(S2, "thr_a", 5);
    advance(6_000);
    leases.sweep();
    expect(seen).toEqual([S1, S1, S1, S1, S1, S2, S2]);
  });

  it("does not fire for a refused acquire, a takeover with nothing to take, or a failing check", () => {
    const { leases } = setup();
    leases.acquire(S1, "thr_a", 60);
    const seen: string[] = [];
    leases.onChange((key) => seen.push(key));
    leases.acquire(S1, "thr_b", 60);
    leases.takeover(S2);
    leases.check(S1, "thr_b", "x");
    expect(seen).toEqual([]);
  });

  it("a throwing listener is ignored", () => {
    const { leases } = setup();
    leases.onChange(() => {
      throw new Error("boom");
    });
    expect(leases.acquire(S1, "thr_a", 60)).toMatchObject({ ok: true });
  });
});

