import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  GRANT_ACCOUNT_MESSAGE,
  GRANT_GOOGLE_MESSAGE,
  GRANT_RIGHT_MESSAGE,
  PLUGIN_API_METHODS,
  PLUGIN_ID_MESSAGE,
  PLUGIN_ONLY_MESSAGE,
  PLUGIN_OWNER_METHODS,
  REQUEST_INVALID_MESSAGE,
  REQUEST_LIMIT_MESSAGE,
} from "../../core/plugin-api.ts";
import type { LogEntryInput } from "../../core/agent-log.ts";
import { createPluginApi, type PluginReads } from "./plugin-api-rpc.ts";
import { guardHandlers } from "./plugin-guard.ts";
import { MIGRATIONS, createSqliteStore } from "./sqlite-store.ts";

const signal = new AbortController().signal;
const as = (pluginId: string): ExperimentalPluginRpcHandlerContext => ({ experimental_caller: { kind: "plugin", pluginId }, experimental_signal: signal });
const owner: ExperimentalPluginRpcHandlerContext = { experimental_caller: { kind: "client" }, experimental_signal: signal };

function setup(overrides: Partial<PluginReads> = {}, start = "2026-11-19T10:00:00.000Z") {
  const db = new Database(":memory:");
  db.transaction(() => MIGRATIONS.forEach((statement) => db.exec(statement)))();
  const add = db.prepare(
    `INSERT INTO accounts (id, email, host, port, username, password_sealed, preset, created_at)
     VALUES (?, ?, 'imap.example.com', 993, ?, 'sealed', 'other', '2026-01-01T00:00:00.000Z')`,
  );
  add.run("acc_1", "first@example.com", "first");
  add.run("acc_2", "second@example.net", "second");
  const store = createSqliteStore(db);
  const clock = { now: new Date(start) };
  const announced: (string | null)[] = [];
  const logged: LogEntryInput[] = [];
  const reads: PluginReads = {
    search: () => ({ hits: [], nextCursor: null }),
    read: () => null,
    contacts: () => [],
    shared: () => null,
    calendarPart: () => false,
    invite: async () => null,
    ...overrides,
  };
  const api = createPluginApi({
    store,
    now: () => clock.now,
    announce: (request) => void announced.push(request),
    log: (entry) => void logged.push(entry),
    clockMs: () => clock.now.getTime(),
    reads,
    propose: async () => ({ ok: false, reason: "account" }),
  });
  const guarded = guardHandlers(api.handlers, { api: new Set(PLUGIN_API_METHODS), check: api.check });
  return { store, clock, announced, logged, api: guarded };
}

describe("asking for access", () => {
  it("a plugin with nothing sees the version, no grants and no request", async () => {
    const { api } = setup();
    expect(await api.plugin_access_info({}, as("calendar"))).toEqual({ apiVersion: 1, grants: [], request: null });
  });

  it("a request is kept, announced once and shown back to the plugin, not to another", async () => {
    const { api, announced } = setup();
    expect(await api.plugin_access_request({ rights: ["mail.read", "invites.read"], reason: "Calendar sync" }, as("calendar"))).toEqual({ ok: true });
    expect(announced).toEqual(["calendar"]);
    expect(await api.plugin_access_info({}, as("calendar"))).toEqual({
      apiVersion: 1,
      grants: [],
      request: { rights: ["mail.read", "invites.read"], reason: "Calendar sync", askedAt: "2026-11-19T10:00:00.000Z" },
    });
    expect(await api.plugin_access_info({}, as("crm"))).toMatchObject({ request: null });
  });

  it("asking gives nothing by itself", async () => {
    const { api, store } = setup();
    await api.plugin_access_request({ rights: ["mail.read"], reason: "" }, as("calendar"));
    expect(store.listPluginGrants()).toEqual([]);
  });

  it("the sixth request within 24 hours is refused, kept out and not announced", async () => {
    const { api, clock, announced, store } = setup();
    for (let i = 0; i < 5; i++) {
      clock.now = new Date(Date.parse("2026-11-19T10:00:00.000Z") + i * 60_000);
      await api.plugin_access_request({ rights: ["mail.read"], reason: `r${i}` }, as("calendar"));
    }
    clock.now = new Date("2026-11-19T11:00:00.000Z");
    await expect(api.plugin_access_request({ rights: ["mail.read"], reason: "r5" }, as("calendar"))).rejects.toMatchObject({
      code: "conflict",
      message: REQUEST_LIMIT_MESSAGE,
    });
    expect(announced).toHaveLength(5);
    expect(store.getPluginRequests()[0]!.reason).toBe("r4");
    // Another plugin is not held by this one's limit; the next day neither is.
    await expect(api.plugin_access_request({ rights: ["mail.read"], reason: "" }, as("crm"))).resolves.toEqual({ ok: true });
    clock.now = new Date("2026-11-20T10:05:00.000Z");
    await expect(api.plugin_access_request({ rights: ["mail.read"], reason: "next day" }, as("calendar"))).resolves.toEqual({ ok: true });
  });

  it("an unknown right refuses the whole request", async () => {
    const { api, store, announced } = setup();
    await expect(api.plugin_access_request({ rights: ["mail.read", "mail.delete"], reason: "x" }, as("calendar"))).rejects.toMatchObject({
      code: "invalid",
      message: REQUEST_INVALID_MESSAGE,
    });
    await expect(api.plugin_access_request({ rights: [], reason: "x" }, as("calendar"))).rejects.toMatchObject({ code: "invalid" });
    expect(store.getPluginRequests()).toEqual([]);
    expect(announced).toEqual([]);
  });

  it("a very long plugin id is refused; one that looks like markup is kept as text", async () => {
    const { api, store } = setup();
    await expect(api.plugin_access_request({ rights: ["mail.read"], reason: "" }, as("p".repeat(300)))).rejects.toMatchObject({
      code: "invalid",
      message: PLUGIN_ID_MESSAGE,
    });
    await api.plugin_access_request({ rights: ["mail.read"], reason: "" }, as("<img src=x>"));
    expect(store.getPluginRequests().map((request) => request.pluginId)).toEqual(["<img src=x>"]);
  });

  it("a client caller is refused on the plugins' own methods", async () => {
    const { api } = setup();
    await expect(api.plugin_access_info({}, owner)).rejects.toMatchObject({ code: "forbidden", message: PLUGIN_ONLY_MESSAGE });
    await expect(api.plugin_access_request({ rights: ["mail.read"], reason: "" }, owner)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the owner's grants", () => {
  it("a grant is set, listed with its plugin and seen by that plugin", async () => {
    const { api, announced } = setup();
    expect(await api.plugin_grant_set({ pluginId: "crm", right: "mail.read", accountId: "acc_1", on: true }, owner)).toEqual({ ok: true });
    expect(await api.plugin_grants_list({}, owner)).toEqual({
      plugins: [{ pluginId: "crm", grants: [{ right: "mail.read", accountId: "acc_1", grantedAt: "2026-11-19T10:00:00.000Z" }], lastCallAt: null }],
      requests: [],
    });
    expect(await api.plugin_access_info({}, as("crm"))).toMatchObject({ grants: [{ right: "mail.read", accountId: "acc_1" }] });
    expect(announced).toEqual([null]);
    await api.plugin_grant_set({ pluginId: "crm", right: "mail.read", accountId: "acc_1", on: false }, owner);
    expect(await api.plugin_grants_list({}, owner)).toEqual({ plugins: [], requests: [] });
  });

  it("lists a request with its plugin, and dismissing it grants nothing", async () => {
    const { api, store } = setup();
    await api.plugin_access_request({ rights: ["contacts.read"], reason: "People" }, as("crm"));
    expect(await api.plugin_grants_list({}, owner)).toEqual({
      plugins: [],
      requests: [{ pluginId: "crm", rights: ["contacts.read"], reason: "People", askedAt: "2026-11-19T10:00:00.000Z" }],
    });
    await api.plugin_request_dismiss({ pluginId: "crm" }, owner);
    expect(await api.plugin_grants_list({}, owner)).toEqual({ plugins: [], requests: [] });
    expect(store.listPluginGrants()).toEqual([]);
  });

  it("revoke takes everything a plugin has and asked for", async () => {
    const { api } = setup();
    await api.plugin_grant_set({ pluginId: "crm", right: "mail.read", accountId: "acc_1", on: true }, owner);
    await api.plugin_grant_set({ pluginId: "crm", right: "contacts.read", accountId: "acc_2", on: true }, owner);
    await api.plugin_access_request({ rights: ["invites.read"], reason: "" }, as("crm"));
    await api.plugin_grant_revoke({ pluginId: "crm" }, owner);
    expect(await api.plugin_access_info({}, as("crm"))).toEqual({ apiVersion: 1, grants: [], request: null });
  });

  it("refuses an unknown account, an unknown right and a Google key from here", async () => {
    const { api, store } = setup();
    await expect(api.plugin_grant_set({ pluginId: "crm", right: "mail.read", accountId: "acc_9", on: true }, owner)).rejects.toMatchObject({
      code: "not_found",
      message: GRANT_ACCOUNT_MESSAGE,
    });
    await expect(api.plugin_grant_set({ pluginId: "crm", right: "mail.delete", accountId: "acc_1", on: true }, owner)).rejects.toMatchObject({
      code: "invalid",
      message: GRANT_RIGHT_MESSAGE,
    });
    await expect(api.plugin_grant_set({ pluginId: "crm", right: "google.calendar", accountId: "acc_1", on: true }, owner)).rejects.toMatchObject({
      code: "invalid",
      message: GRANT_GOOGLE_MESSAGE,
    });
    expect(store.listPluginGrants()).toEqual([]);
  });

  it("a plugin cannot grant, revoke, list or dismiss", async () => {
    const { api, store } = setup();
    expect([...PLUGIN_OWNER_METHODS].sort()).toEqual(["plugin_grant_revoke", "plugin_grant_set", "plugin_grants_list", "plugin_request_dismiss"]);
    await expect(api.plugin_grant_set({ pluginId: "crm", right: "mail.read", accountId: "acc_1", on: true }, as("crm"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(api.plugin_grants_list({}, as("crm"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(api.plugin_grant_revoke({ pluginId: "other" }, as("crm"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(api.plugin_request_dismiss({ pluginId: "other" }, as("crm"))).rejects.toMatchObject({ code: "forbidden" });
    expect(store.listPluginGrants()).toEqual([]);
  });
});

describe("reading an invitation", () => {
  const header = { id: "m_1", accountId: "acc_1" } as never;
  const invite = {
    method: "request",
    uid: "u1",
    sequence: 0,
    summary: "Invented sync, password: hunter2secret",
    location: "Room 4, passcode 918273",
    description: "Join with one-time code 554433",
    start: null,
    end: null,
    organizer: { name: "Ada password: Qm7xR2pLk9", address: "ada@example.com" },
    attendees: [{ name: "Bob token ghp_Zx81Kq7Lm2Np4Rt6Vw9Yb3Cd5Ef7Gh1Jk0Mn", address: "bob@example.net", status: "accepted", optional: false }],
    attendeesTotal: 1,
    recurring: false,
    cancelled: false,
    self: null,
  } as never;

  function granted(overrides: Partial<PluginReads>) {
    const context = setup({ shared: () => header, calendarPart: () => true, invite: async () => invite, ...overrides });
    context.store.setPluginGrant({ pluginId: "calendar", right: "invites.read", accountId: "acc_1", grantedAt: "2026-11-19T10:00:00.000Z" }, true);
    return context;
  }

  it("hides secrets in the event's text and in people's names", async () => {
    const { api } = granted({});
    const text = JSON.stringify(await api.plugin_invite_read({ messageId: "m_1" }, as("calendar")));
    for (const secret of ["hunter2secret", "Qm7xR2pLk9", "ghp_Zx81Kq7Lm2Np4Rt6Vw9Yb3Cd5Ef7Gh1Jk0Mn"]) expect(text).not.toContain(secret);
    expect(text).toContain("Invented sync");
    expect(text).toContain("ada@example.com");
  });

  it("does not go to the mail server for a message without a calendar part", async () => {
    let fetched = 0;
    const { api } = granted({ calendarPart: () => false, invite: async () => (fetched++, invite) });
    await expect(api.plugin_invite_read({ messageId: "m_1" }, as("calendar"))).rejects.toMatchObject({ code: "not_found" });
    expect(fetched).toBe(0);
  });

  it("reads at most 30 invitations an hour per plugin", async () => {
    let fetched = 0;
    const { api, clock } = granted({ invite: async () => (fetched++, invite) });
    for (let i = 0; i < 30; i++) await api.plugin_invite_read({ messageId: "m_1" }, as("calendar"));
    await expect(api.plugin_invite_read({ messageId: "m_1" }, as("calendar"))).rejects.toMatchObject({ code: "conflict" });
    expect(fetched).toBe(30);
    clock.now = new Date(clock.now.getTime() + 61 * 60_000);
    await expect(api.plugin_invite_read({ messageId: "m_1" }, as("calendar"))).resolves.toBeTruthy();
  });
});
