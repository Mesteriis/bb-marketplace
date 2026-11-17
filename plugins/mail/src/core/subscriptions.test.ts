import { describe, expect, it } from "vitest";
import { groupSubscriptions, type SubscriptionRow } from "./subscriptions.ts";
import type { UnsubscribeInfo } from "./unsubscribe.ts";

const info = (overrides: Partial<UnsubscribeInfo> = {}): UnsubscribeInfo => ({
  listKey: "id:news.example.com",
  listName: "Invented News",
  https: "https://lists.example.com/u/1",
  oneClick: true,
  mailto: null,
  trust: "covered",
  ...overrides,
});

let n = 0;
const row = (overrides: Partial<SubscriptionRow> = {}): SubscriptionRow => {
  n += 1;
  return {
    id: `m_${n}`,
    accountId: "acc_1",
    dedupKey: `k_${n}`,
    fromName: "News",
    fromAddress: "digest@news.example.com",
    date: `2026-11-${String(30 - (n % 20)).padStart(2, "0")}T08:00:00.000Z`,
    isRead: true,
    info: info(),
    ...overrides,
  };
};

describe("groupSubscriptions", () => {
  it("groups by list and account, counts distinct messages, and takes the newest as the one to ask with", () => {
    const rows = [
      row({ id: "newest", isRead: false, date: "2026-11-17T08:00:00.000Z" }),
      row({ dedupKey: "same", date: "2026-11-16T08:00:00.000Z" }),
      // The same message in another folder (Gmail's All Mail) counts once.
      row({ dedupKey: "same", isRead: false, date: "2026-11-16T08:00:00.000Z" }),
      row({ accountId: "acc_2", id: "other-account", date: "2026-11-15T08:00:00.000Z" }),
    ];
    expect(groupSubscriptions(rows)).toEqual([
      {
        messageId: "newest",
        accountId: "acc_1",
        listKey: "id:news.example.com",
        name: "Invented News",
        address: "digest@news.example.com",
        total: 2,
        unread: 2,
        lastDate: "2026-11-17T08:00:00.000Z",
        method: "one_click",
        target: "lists.example.com",
        batch: true,
        mail: null,
      },
      expect.objectContaining({ messageId: "other-account", accountId: "acc_2", total: 1, unread: 0 }),
    ]);
  });

  it("a list without a List-Id is one sender's address", () => {
    const from = (address: string) => row({ fromAddress: address, info: info({ listKey: "from:shared", listName: null }) });
    const lists = groupSubscriptions([from("a@shop.example.com"), from("A@shop.example.com"), from("b@shop.example.com")]);
    expect(lists.map((l) => [l.address, l.total])).toEqual([
      ["a@shop.example.com", 2],
      ["b@shop.example.com", 1],
    ]);
    expect(lists[0]!.name).toBe("News");
  });

  it("picks one-click only when the message is covered, else the mailto; a mailto to another domain is not for a batch", () => {
    const mailto = { address: "leave@news.example.com", subject: "unsubscribe", body: "" };
    const pick = (i: Partial<UnsubscribeInfo>) => {
      const [list] = groupSubscriptions([row({ info: info(i) })]);
      return [list!.method, list!.target, list!.batch];
    };
    expect(groupSubscriptions([row({ info: info({ oneClick: false, mailto: { ...mailto, subject: "", body: "leave\u200b me" } }) })])[0]!.mail).toEqual({
      subject: "unsubscribe",
      body: "leave me",
      hiddenChars: 1,
    });
    expect(pick({})).toEqual(["one_click", "lists.example.com", true]);
    expect(pick({ trust: "not_covered", mailto })).toEqual(["mailto", "leave@news.example.com", true]);
    expect(pick({ oneClick: false, mailto: { ...mailto, address: "leave@elsewhere.example.net" } })).toEqual([
      "mailto",
      "leave@elsewhere.example.net",
      false,
    ]);
    expect(pick({ trust: "no_dkim" })).toEqual([null, null, false]);
  });

  it("orders by how much a list sends and keeps the largest", () => {
    const many = (key: string, count: number) => Array.from({ length: count }, () => row({ info: info({ listKey: `id:${key}`, listName: key }) }));
    const lists = groupSubscriptions([...many("small", 1), ...many("big", 5), ...many("middle", 3)], 2);
    expect(lists.map((l) => [l.name, l.total])).toEqual([
      ["big", 5],
      ["middle", 3],
    ]);
  });
});
