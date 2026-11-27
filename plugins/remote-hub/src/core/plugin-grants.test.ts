import { describe, expect, it } from "vitest";
import { PluginGrantBook, type PluginGrantRow, type PluginGrantStore } from "./plugin-grants.ts";

const P1 = "5b568675-f842-4a96-83e0-78ae53d96024";
const P2 = "6c679786-0953-4ba7-94f1-89bf64ea7135";

function memory(): PluginGrantStore & { rows: Map<string, PluginGrantRow> } {
  const rows = new Map<string, PluginGrantRow>();
  const key = (pluginId: string, profileId: string) => `${pluginId}\n${profileId}`;
  return {
    rows,
    all: () => [...rows.values()],
    get: (pluginId, profileId) => rows.get(key(pluginId, profileId)) ?? null,
    put: (row) => void rows.set(key(row.pluginId, row.profileId), row),
    remove: (pluginId, profileId) => rows.delete(key(pluginId, profileId)),
  };
}

function book() {
  let n = 0;
  const changes: Array<{ pluginId: string; profileId: string; state: string }> = [];
  const store = memory();
  const b = new PluginGrantBook({
    store,
    now: () => new Date("2026-11-27T12:00:00.000Z"),
    newId: () => `00000000-0000-4000-8000-00000000000${++n}`,
    profileExists: (id) => id === P1 || id === P2,
    onChange: (c) => changes.push(c),
  });
  return { b, store, changes };
}

describe("PluginGrantBook", () => {
  it("a plugin that never asked has no consent and is told consent is required", () => {
    const { b } = book();
    expect(b.consentOf("commander", P1)).toEqual({ consent: "none", level: null });
    expect(b.check("commander", P1, "read")).toEqual({ ok: false, code: "consent_required" });
  });

  it("a request waits for the owner and grants nothing; asking again returns the same request", () => {
    const { b, changes } = book();
    const first = b.request("commander", P1, "read", "browse logs");
    expect(first).toEqual({ requestId: "00000000-0000-4000-8000-000000000001", state: "pending" });
    expect(b.request("commander", P1, "read")).toEqual(first);
    expect(b.check("commander", P1, "read")).toEqual({ ok: false, code: "consent_required" });
    expect(b.consentOf("commander", P1)).toEqual({ consent: "pending", level: null });
    expect(changes).toEqual([{ pluginId: "commander", profileId: P1, state: "pending" }]);
  });

  it("a request for a profile that does not exist is refused", () => {
    const { b } = book();
    expect(() => b.request("commander", "7d78a897-1a64-4cb8-a502-9ac075fb8246", "read")).toThrow(/^profile_not_found/);
  });

  it("the owner grants a level; write includes read, read does not include write", () => {
    const { b } = book();
    const asked = b.request("commander", P1, "read");
    b.grant("commander", P1, "read");
    expect(b.request("commander", P1, "read")).toEqual({ requestId: asked.requestId, state: "granted" }); // the answered request keeps its id
    expect(b.check("commander", P1, "read")).toEqual({ ok: true, level: "read" });
    expect(b.check("commander", P1, "write")).toEqual({ ok: false, code: "consent_required" });
    b.grant("commander", P1, "write");
    expect(b.check("commander", P1, "read")).toEqual({ ok: true, level: "write" });
    expect(b.check("commander", P1, "write")).toEqual({ ok: true, level: "write" });
    expect(b.consentOf("commander", P1)).toEqual({ consent: "granted", level: "write" });
  });

  it("a grant belongs to one plugin and one profile", () => {
    const { b } = book();
    b.grant("commander", P1, "write");
    expect(b.check("other-plugin", P1, "read")).toEqual({ ok: false, code: "consent_required" });
    expect(b.check("commander", P2, "read")).toEqual({ ok: false, code: "consent_required" });
  });

  it("asking for what is already granted answers granted; asking for more keeps the grant and waits for the owner", () => {
    const { b } = book();
    b.grant("commander", P1, "read");
    expect(b.request("commander", P1, "read")).toEqual({ requestId: "00000000-0000-4000-8000-000000000001", state: "granted" });
    expect(b.request("commander", P1, "read")).toEqual({ requestId: "00000000-0000-4000-8000-000000000001", state: "granted" });
    expect(b.request("commander", P1, "write").state).toBe("pending");
    expect(b.check("commander", P1, "read")).toEqual({ ok: true, level: "read" });
    expect(b.list("commander")).toEqual([{ profileId: P1, level: "read", state: "granted", grantedAt: "2026-11-27T12:00:00.000Z" }]);
    expect(b.pending()).toEqual([{ requestId: "00000000-0000-4000-8000-000000000002", pluginId: "commander", profileId: P1, level: "write", reason: null, requestedAt: "2026-11-27T12:00:00.000Z" }]);
  });

  it("revoking says so on the next check, tells the listeners, and a new request can follow", () => {
    const { b, changes } = book();
    b.grant("commander", P1, "write");
    expect(b.revoke("commander", P1)).toBe(true);
    expect(b.check("commander", P1, "read")).toEqual({ ok: false, code: "consent_revoked" });
    expect(b.consentOf("commander", P1)).toEqual({ consent: "revoked", level: null });
    expect(changes.at(-1)).toEqual({ pluginId: "commander", profileId: P1, state: "revoked" });
    expect(b.revoke("commander", P1)).toBe(false);
    expect(b.request("commander", P1, "read").state).toBe("pending");
    expect(b.check("commander", P1, "read")).toEqual({ ok: false, code: "consent_required" });
  });

  it("the owner can decline a request: nothing is granted and the plugin may ask again", () => {
    const { b } = book();
    const { requestId } = b.request("commander", P1, "write");
    expect(b.decline(requestId)).toBe(true);
    expect(b.consentOf("commander", P1)).toEqual({ consent: "none", level: null });
    expect(b.pending()).toEqual([]);
    expect(b.decline(requestId)).toBe(false);
  });

  it("revoke all ends every grant and every pending request, and counts the grants", () => {
    const { b } = book();
    b.grant("commander", P1, "write");
    b.grant("other-plugin", P2, "read");
    b.request("commander", P2, "read");
    expect(b.revokeAll()).toBe(2);
    expect(b.check("commander", P1, "read")).toEqual({ ok: false, code: "consent_revoked" });
    expect(b.check("other-plugin", P2, "read")).toEqual({ ok: false, code: "consent_revoked" });
    expect(b.pending()).toEqual([]);
  });

  it("deleting a profile forgets everything about it", () => {
    const { b, store } = book();
    b.grant("commander", P1, "write");
    b.grant("commander", P2, "read");
    b.forgetProfile(P1);
    expect(store.all().map((r) => r.profileId)).toEqual([P2]);
  });
});
