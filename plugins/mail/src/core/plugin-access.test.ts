import { describe, expect, it } from "vitest";

import { cleanRequest, grantedAccounts, hasRight, overDailyLimit, type PluginGrant } from "./plugin-access.ts";

const at = "2026-11-19T10:00:00.000Z";
const grants: PluginGrant[] = [
  { pluginId: "crm", right: "mail.read", accountId: "acc_1", grantedAt: at },
  { pluginId: "crm", right: "contacts.read", accountId: "acc_2", grantedAt: at },
  { pluginId: "calendar", right: "mail.read", accountId: "acc_2", grantedAt: at },
];

describe("plugin access", () => {
  it("a right holds only for the exact plugin, right and account", () => {
    expect(hasRight(grants, "crm", "mail.read", "acc_1")).toBe(true);
    expect(hasRight(grants, "calendar", "mail.read", "acc_1")).toBe(false);
    expect(hasRight(grants, "crm", "contacts.read", "acc_1")).toBe(false);
    expect(hasRight(grants, "crm", "mail.read", "acc_2")).toBe(false);
    expect(hasRight([], "crm", "mail.read", "acc_1")).toBe(false);
  });

  it("lists the accounts a plugin holds a right for", () => {
    expect(grantedAccounts(grants, "crm", "mail.read")).toEqual(["acc_1"]);
    expect(grantedAccounts(grants, "crm", "invites.read")).toEqual([]);
  });

  it("keeps a request as known rights once each and a one-line reason", () => {
    expect(cleanRequest({ rights: ["mail.read", "mail.read"], reason: " a\nb " })).toEqual({ ok: true, rights: ["mail.read"], reason: "a b" });
    const long = cleanRequest({ rights: ["invites.read"], reason: "x".repeat(250) });
    expect(long.ok && long.reason.length).toBe(200);
  });

  it("refuses a request with an unknown right or none", () => {
    expect(cleanRequest({ rights: ["mail.delete"], reason: "x" })).toEqual({ ok: false });
    expect(cleanRequest({ rights: ["mail.read", "mail.delete"], reason: "x" })).toEqual({ ok: false });
    expect(cleanRequest({ rights: [], reason: "x" })).toEqual({ ok: false });
  });

  it("counts a daily limit over the last 24 hours only", () => {
    const now = new Date("2026-11-19T12:00:00.000Z");
    const inside = ["2026-11-19T11:00:00.000Z", "2026-11-19T10:00:00.000Z", "2026-11-19T09:00:00.000Z", "2026-11-19T08:00:00.000Z"];
    expect(overDailyLimit([...inside, "2026-11-18T13:00:00.000Z"], now, 5)).toBe(true);
    expect(overDailyLimit([...inside, "2026-11-18T11:00:00.000Z"], now, 5)).toBe(false);
    expect(overDailyLimit([], now, 5)).toBe(false);
  });
});
