import { describe, expect, it } from "vitest";
import type { NewMailItem } from "../core/model.ts";
import { newMailToastPlan } from "./new-mail-toasts.ts";

const item = (n: number, overrides: Partial<NewMailItem> = {}): NewMailItem => ({
  accountId: "acc-1",
  threadId: `th-${n}`,
  messageId: `m-${n}`,
  name: `Person ${n}`,
  address: `person${n}@example.com`,
  ...overrides,
});

describe("newMailToastPlan", () => {
  it("one sender: the name, the address, Open to that conversation", () => {
    expect(newMailToastPlan([item(1, { name: "Ada Example", address: "ada@example.com" })], 0, false)).toEqual({
      title: "New mail from Ada Example",
      description: "ada@example.com",
      open: { accountId: "acc-1", threadId: "th-1" },
    });
  });

  it("several: the newest sender and how many more, never a subject", () => {
    const plan = newMailToastPlan([item(3), item(2), item(1)], 2, false)!;
    expect(plan).toEqual({
      title: "New mail from Person 3 and 4 more",
      description: "5 messages",
      open: { accountId: "acc-1", threadId: "th-3" },
    });
    expect(Object.keys(plan)).toEqual(["title", "description", "open"]);
  });

  it("nothing while the Mail page shows an Inbox, and nothing for no senders", () => {
    expect(newMailToastPlan([item(1)], 0, true)).toBeNull();
    expect(newMailToastPlan([], 3, false)).toBeNull();
  });
});
