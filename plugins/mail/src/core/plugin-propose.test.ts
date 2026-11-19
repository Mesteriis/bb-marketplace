import { describe, expect, it } from "vitest";

import { PROPOSALS_PER_DAY } from "./plugin-access.ts";
import { proposePluginLetter } from "./plugin-propose.ts";
import { InMemoryMailStore, makeStoredAccount } from "./testing/fakes.ts";

function setup() {
  const store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount());
  let n = 0;
  const clock = { at: new Date("2026-11-19T10:00:00.000Z") };
  const deps = { store, newId: () => `id-${++n}`, clock: { now: () => clock.at } };
  return { store, deps, clock };
}

const letter = { accountId: "acc_1", to: ["Ada <ada@example.com>"], cc: [], subject: "Invented plan", text: "First line\nSecond line" };

describe("proposePluginLetter", () => {
  it("makes a marked draft with the plugin's recipients, subject and text, and queues nothing", async () => {
    const { store, deps } = setup();
    const result = await proposePluginLetter(deps as never, "calendar", { ...letter, cc: ["bob@example.net"] });
    expect(result.ok).toBe(true);
    const draft = store.getDraft(result.ok ? result.draftId : "")!;
    expect(draft).toMatchObject({
      accountId: "acc_1",
      kind: "new",
      preparedBy: "calendar",
      proposalId: null,
      subject: "Invented plan",
      to: [{ name: "Ada", address: "ada@example.com" }],
      cc: [{ name: null, address: "bob@example.net" }],
      bcc: [],
    });
    expect(JSON.stringify(draft.doc)).toContain("First line");
    expect(JSON.stringify(draft.doc)).toContain("Second line");
    expect(store.listOutbox("acc_1")).toEqual([]);
  });

  it("refuses an unknown account, no recipient and a bad address, and makes no draft", async () => {
    const { store, deps } = setup();
    expect(await proposePluginLetter(deps as never, "calendar", { ...letter, accountId: "acc_9" })).toEqual({ ok: false, reason: "account" });
    expect(await proposePluginLetter(deps as never, "calendar", { ...letter, to: [] })).toEqual({ ok: false, reason: "no_recipients" });
    expect(await proposePluginLetter(deps as never, "calendar", { ...letter, to: ["not an address"] })).toEqual({ ok: false, reason: "address" });
    expect(await proposePluginLetter(deps as never, "calendar", { ...letter, cc: ["ada@example.com", "x@"] })).toEqual({ ok: false, reason: "address" });
    expect(store.listDrafts("acc_1")).toEqual([]);
  });

  it("refuses a letter over the document size", async () => {
    const { store, deps } = setup();
    expect(await proposePluginLetter(deps as never, "calendar", { ...letter, text: "x".repeat(2 * 1024 * 1024 + 1) })).toEqual({ ok: false, reason: "too_large" });
    expect(store.listDrafts("acc_1")).toEqual([]);
  });

  it("the 21st letter of a plugin within 24 hours is refused; another plugin and the next day are not", async () => {
    const { store, deps, clock } = setup();
    expect(PROPOSALS_PER_DAY).toBe(20);
    for (let i = 0; i < 20; i++) {
      clock.at = new Date(Date.parse("2026-11-19T10:00:00.000Z") + i * 60_000);
      expect((await proposePluginLetter(deps as never, "calendar", letter)).ok).toBe(true);
    }
    clock.at = new Date("2026-11-19T11:00:00.000Z");
    expect(await proposePluginLetter(deps as never, "calendar", letter)).toEqual({ ok: false, reason: "limit" });
    expect(store.listDrafts("acc_1")).toHaveLength(20);
    expect((await proposePluginLetter(deps as never, "crm", letter)).ok).toBe(true);
    clock.at = new Date("2026-11-20T10:30:00.000Z");
    expect((await proposePluginLetter(deps as never, "calendar", letter)).ok).toBe(true);
  });
});
