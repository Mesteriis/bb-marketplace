import { describe, expect, it } from "vitest";
import { consoleAvailability, guestKey, outcomeOfFailure, PveDiscovery, searchGuests, viewOf, type PveAnswer } from "./pve-targets.ts";

const NOW = new Date("2026-11-18T12:00:00.000Z");
const FP = "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E";

const GOOD: PveAnswer = {
  ok: true,
  version: "9.0.3",
  nodes: [{ node: "pve1", status: "online" }],
  guests: [
    { vmid: 100, name: "db", kind: "qemu", node: "pve1", status: "running", template: false },
    { vmid: 101, name: "web", kind: "lxc", node: "pve1", status: "stopped", template: false },
    { vmid: 9000, name: "tpl", kind: "qemu", node: "pve1", status: "stopped", template: true },
  ],
};

describe("console availability", () => {
  it("is open only for a running guest that is not a template, with the reason otherwise", () => {
    expect(consoleAvailability({ kind: "lxc", status: "running", template: false })).toEqual({ available: true, reason: null });
    expect(consoleAvailability({ kind: "lxc", status: "stopped", template: false })).toEqual({
      available: false,
      reason: "the guest is stopped; start it in Proxmox first (Remote Hub never starts guests)",
    });
    expect(consoleAvailability({ kind: "qemu", status: "stopped", template: true })).toEqual({ available: false, reason: "a template has no console" });
  });
});

describe("outcomes", () => {
  it("maps the helper's failure codes to a closed set", () => {
    expect(outcomeOfFailure("login_failed")).toBe("login_failed");
    expect(outcomeOfFailure("no_permission")).toBe("no_permission");
    expect(outcomeOfFailure("timeout")).toBe("unreachable");
    expect(outcomeOfFailure("unreachable")).toBe("unreachable");
    expect(outcomeOfFailure("tls_untrusted")).toBe("tls_untrusted");
    expect(outcomeOfFailure("cert_changed")).toBe("cert_changed");
    expect(outcomeOfFailure("tfa_required")).toBe("tfa_required");
    expect(outcomeOfFailure("api_error")).toBe("error");
    expect(outcomeOfFailure("something new")).toBe("error");
  });

  it("an empty answer is `empty`, not an error and not `ok`", () => {
    const { view } = viewOf({ profile: { id: "p", name: "lab" }, answer: { ok: true, version: "9.0.3", nodes: [], guests: [] }, cached: null, links: new Map(), now: NOW });
    expect(view.outcome).toBe("empty");
    expect(view.message).toBeNull();
    expect(view.guests).toEqual([]);
  });

  it("a good answer carries identity, console state and the owner's link; the node is only a location", () => {
    const { view, cache } = viewOf({ profile: { id: "p1", name: "lab" }, answer: GOOD, cached: null, links: new Map([[100, "ssh-profile"]]), now: NOW });
    expect(view.outcome).toBe("ok");
    expect(view.guests.map((g) => [g.key, g.node, g.console.available, g.linkedProfileId])).toEqual([
      ["p1/100", "pve1", true, "ssh-profile"],
      ["p1/101", "pve1", false, null],
      ["p1/9000", "pve1", false, null],
    ]);
    expect(cache?.at).toEqual(NOW);
  });

  it("the same VMID in two environments never shares an identity", () => {
    expect(guestKey("env-a", 100)).toBe("env-a/100");
    expect(guestKey("env-b", 100)).toBe("env-b/100");
    expect(guestKey("env-a", 100)).not.toBe(guestKey("env-b", 100));
  });
});

describe("stale data", () => {
  const cached = { at: new Date("2026-11-18T11:58:30.000Z"), version: "9.0.3", nodes: [{ node: "pve1", status: "online" }], guests: (GOOD as Extract<PveAnswer, { ok: true }>).guests };

  it("an unreachable endpoint serves the last good list with its age", () => {
    const { view } = viewOf({ profile: { id: "p", name: "lab" }, answer: { ok: false, code: "unreachable", message: "", fingerprint: null }, cached, links: new Map(), now: NOW });
    expect(view.outcome).toBe("unreachable");
    expect(view.stale).toEqual({ ageSeconds: 90 });
    expect(view.guests.length).toBe(3);
    expect(view.fetchedAt).toBe("2026-11-18T11:58:30.000Z");
    expect(view.message).toContain("did not answer");
  });

  it("a refused login, missing permission or a certificate problem never show old data as current", () => {
    for (const code of ["login_failed", "no_permission", "tls_untrusted", "cert_changed", "tfa_required"]) {
      const { view } = viewOf({ profile: { id: "p", name: "lab" }, answer: { ok: false, code, message: "", fingerprint: FP }, cached, links: new Map(), now: NOW });
      expect(view.guests, code).toEqual([]);
      expect(view.stale, code).toBeNull();
    }
  });

  it("carries the presented fingerprint for the two certificate outcomes", () => {
    const { view } = viewOf({ profile: { id: "p", name: "lab" }, answer: { ok: false, code: "tls_untrusted", message: "", fingerprint: FP }, cached: null, links: new Map(), now: NOW });
    expect(view.fingerprint).toBe(FP);
    expect(view.message).toContain("fingerprint");
  });
});

describe("search", () => {
  const g = (vmid: number, name: string, node: string, kind: string) => ({ vmid, name, node, kind });
  const list = [g(100, "Database", "pve1", "qemu"), g(101, "web-1", "pve2", "lxc"), g(1010, "cache", "pve1", "lxc")];
  it("matches name (any case), VMID prefix, node and kind", () => {
    expect(searchGuests(list, "data").map((x) => x.vmid)).toEqual([100]);
    expect(searchGuests(list, "101").map((x) => x.vmid)).toEqual([101, 1010]);
    expect(searchGuests(list, "PVE2").map((x) => x.vmid)).toEqual([101]);
    expect(searchGuests(list, "lxc").map((x) => x.vmid)).toEqual([101, 1010]);
    expect(searchGuests(list, "  ").length).toBe(3);
    expect(searchGuests(list, "zzz")).toEqual([]);
  });
});

describe("PveDiscovery", () => {
  const profiles = [
    { id: "a", name: "env-a", credentialRef: "rh-cred:v1:local:x" },
    { id: "b", name: "env-b", credentialRef: "rh-cred:v1:local:y" },
    { id: "c", name: "env-c", credentialRef: null },
  ];
  let calls: string[] = [];
  function make(fetch: (id: string) => Promise<PveAnswer>, clock: { t: Date } = { t: NOW }) {
    calls = [];
    return new PveDiscovery({
      profiles: () => profiles,
      fetch: (id) => {
        calls.push(id);
        return fetch(id);
      },
      links: () => new Map(),
      now: () => clock.t,
    });
  }

  it("one failing connection does not hide the others", async () => {
    const d = make(async (id) => {
      if (id === "a") throw new Error("boom");
      return GOOD;
    });
    const views = await d.targets({ refresh: true });
    expect(views.map((v) => [v.profileId, v.outcome])).toEqual([
      ["a", "error"],
      ["b", "ok"],
      ["c", "no_credential"],
    ]);
    expect(calls).toEqual(["a", "b"]);
  });

  it("two environments with the same VMID give different guest keys", async () => {
    const d = make(async () => GOOD);
    const [a, b] = await d.targets({ refresh: true });
    expect(a?.guests[0]?.key).toBe("a/100");
    expect(b?.guests[0]?.key).toBe("b/100");
  });

  it("serves a recent good answer without asking again, and asks again on refresh or after the ttl", async () => {
    const clock = { t: NOW };
    const d = make(async () => GOOD, clock);
    await d.targets({ profileIds: ["b"] });
    await d.targets({ profileIds: ["b"] });
    expect(calls).toEqual(["b"]);
    await d.targets({ profileIds: ["b"], refresh: true });
    expect(calls).toEqual(["b", "b"]);
    clock.t = new Date(NOW.getTime() + 31_000);
    await d.targets({ profileIds: ["b"] });
    expect(calls).toEqual(["b", "b", "b"]);
  });

  it("after a good answer an unreachable one is served stale with its age", async () => {
    const clock = { t: NOW };
    let up = true;
    const d = make(async () => (up ? GOOD : { ok: false, code: "unreachable", message: "", fingerprint: null }), clock);
    await d.targets({ profileIds: ["b"] });
    up = false;
    clock.t = new Date(NOW.getTime() + 120_000);
    const [v] = await d.targets({ profileIds: ["b"], refresh: true });
    expect(v?.outcome).toBe("unreachable");
    expect(v?.stale).toEqual({ ageSeconds: 120 });
    expect(v?.guests.length).toBe(3);
  });

  it("remembers the certificate a refusal presented, for the pin guard", async () => {
    const d = make(async () => ({ ok: false, code: "tls_untrusted", message: "", fingerprint: FP }));
    expect(d.lastPresented("b")).toBeNull();
    await d.targets({ profileIds: ["b"], refresh: true });
    expect(d.lastPresented("b")).toBe(FP);
    d.forget("b");
    expect(d.lastPresented("b")).toBeNull();
  });

  it("a connection asked twice at once makes one request", async () => {
    let release: (a: PveAnswer) => void = () => {};
    const d = make(() => new Promise<PveAnswer>((r) => (release = r)));
    const first = d.targets({ profileIds: ["b"], refresh: true });
    const second = d.targets({ profileIds: ["b"], refresh: true });
    release(GOOD);
    await Promise.all([first, second]);
    expect(calls).toEqual(["b"]);
  });
});
