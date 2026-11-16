import { describe, expect, it, vi } from "vitest";
import { DEV_BACKFILL_BUDGET, devBackfill } from "./dev-backfill.ts";
import { InMemoryMailStore, makeFetchedMessage, makeStoredAccount } from "./testing/fakes.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";
const FOLDERS = [
  { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox" as const, selectable: true },
  { path: "Spam", name: "Spam", delimiter: "/", specialUse: "junk" as const, selectable: true },
];

function setup() {
  const store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount());
  store.saveFolders("acc_1", FOLDERS);
  return store;
}

const day = (n: number) => new Date(Date.UTC(2026, 10, n, 9)).toISOString();
const ci = (uid: number, n: number) =>
  makeFetchedMessage(uid, {
    date: day(n),
    from: { name: "GitHub", address: "notifications@github.com" },
    subject: `[example-org/demo] Run failed: CI - main (abc${uid})`,
  });
const idOf = (store: InMemoryMailStore, folder: string, uid: number) =>
  store.localFolderIndex("acc_1", folder, EPOCH).find((e) => e.uid === uid)!.id;

describe("devBackfill", () => {
  it("classifies from the stored From and subject, newest first, within the budget, and marks the rest checked", () => {
    const store = setup();
    store.upsertMessages("acc_1", "INBOX", [ci(1, 1), makeFetchedMessage(2, { date: day(2) }), ci(3, 3)]);

    const first = devBackfill(store, { budget: 2 });
    expect(first).toEqual({ checked: 2, classified: 1, more: true });
    expect(store.getMessage(idOf(store, "INBOX", 3))!.dev).toMatchObject({ source: "github", kind: "ci", state: "failed" });
    expect(store.getMessage(idOf(store, "INBOX", 1))!.dev).toBeNull();
    expect(store.devUnclassified(10).map((r) => r.id)).toEqual([idOf(store, "INBOX", 1)]);

    expect(devBackfill(store, { budget: 2 })).toEqual({ checked: 1, classified: 1, more: false });
    expect(devBackfill(store, { budget: 2 })).toEqual({ checked: 0, classified: 0, more: false });
    expect(store.getMessage(idOf(store, "INBOX", 1))!.dev).toMatchObject({ source: "github" });
  });

  it("leaves Spam alone and takes DEV_BACKFILL_BUDGET rows by default", () => {
    const store = setup();
    store.upsertMessages("acc_1", "Spam", [ci(1, 1)]);
    expect(devBackfill(store)).toEqual({ checked: 0, classified: 0, more: false });
    expect(DEV_BACKFILL_BUDGET).toBe(2_000);
    const spy = vi.spyOn(store, "devUnclassified");
    devBackfill(store);
    expect(spy).toHaveBeenCalledWith(DEV_BACKFILL_BUDGET + 1);
  });

  it("never throws when the store does", () => {
    const store = setup();
    vi.spyOn(store, "devUnclassified").mockImplementation(() => {
      throw new Error("closed");
    });
    expect(devBackfill(store)).toEqual({ checked: 0, classified: 0, more: false });
  });
});
