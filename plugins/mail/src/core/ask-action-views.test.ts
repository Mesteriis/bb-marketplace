import { describe, expect, it } from "vitest";
import { askActionViews } from "./ask-action-views.ts";
import type { AskAction } from "./ask-actions.ts";
import type { MailStore } from "./ports.ts";

const NOW = "2026-11-20T10:00:00.000Z";
/** Excerpts 1–5 as the plugin sent them. */
const PARTS = [1, 2, 3, 4, 5].map((n) => ({ n, messageId: `m${n}`, text: "" }));

type Stored = { accountId: string; folderRole: "inbox" | "archive" | "sent"; movePending: string | null; threadId: string | null };
const STORED: Record<string, Stored> = {
  m1: { accountId: "acc_1", folderRole: "inbox", movePending: null, threadId: "t1" },
  m2: { accountId: "acc_2", folderRole: "inbox", movePending: null, threadId: "t2" },
  m3: { accountId: "acc_1", folderRole: "archive", movePending: null, threadId: "t3" },
  m4: { accountId: "acc_1", folderRole: "inbox", movePending: "Archive", threadId: "t4" },
  // m5 was deleted since the answer.
};
const store = {
  getMessage: (id: string) => (STORED[id] === undefined ? null : { id, accountId: STORED[id]!.accountId, threadId: STORED[id]!.threadId }),
  notifyRows: (ids: string[]) => ids.filter((id) => STORED[id] !== undefined).map((id) => ({ id, ...STORED[id]! })),
} as unknown as Pick<MailStore, "getMessage" | "notifyRows">;

const views = (actions: AskAction[], sources: number[]) => askActionViews(store, actions, PARTS, NOW, sources);

describe("askActionViews", () => {
  it("an act keeps cited messages that are in an Inbox now, by account, and counts them", () => {
    expect(views([{ type: "act", action: "archive", messages: [1, 2, 3, 4, 5] }], [1, 2, 3, 4, 5])).toEqual([
      {
        type: "act",
        action: "archive",
        groups: [
          { accountId: "acc_1", messageIds: ["m1"] },
          { accountId: "acc_2", messageIds: ["m2"] },
        ],
        count: 2,
      },
    ]);
  });

  it("touches only messages the answer cites; an act left without any is dropped", () => {
    expect(views([{ type: "act", action: "flag", messages: [1, 2] }], [2])).toEqual([
      { type: "act", action: "flag", groups: [{ accountId: "acc_2", messageIds: ["m2"] }], count: 1 },
    ]);
    expect(views([{ type: "act", action: "mark_read", messages: [1, 2] }], [])).toEqual([]);
    expect(views([{ type: "act", action: "archive", messages: [3, 4, 5] }], [3, 4, 5])).toEqual([]);
  });

  it("a reply names its cited message; one to a message that is gone or not cited is dropped", () => {
    const reply = (message: number): AskAction => ({ type: "reply", message, paragraphs: ["Thanks."], linksRemoved: 1 });
    expect(views([reply(2), reply(5), reply(1)], [2, 5])).toEqual([
      { type: "reply", n: 2, messageId: "m2", accountId: "acc_2", threadId: "t2", paragraphs: ["Thanks."], linksRemoved: 1 },
    ]);
  });

  it("passes a search and a new message through", () => {
    expect(views([{ type: "search", query: "from:ann" }, { type: "compose", paragraphs: ["Hello."] }], [])).toEqual([
      { type: "search", query: "from:ann" },
      { type: "compose", paragraphs: ["Hello."], linksRemoved: 0 },
    ]);
  });
});
