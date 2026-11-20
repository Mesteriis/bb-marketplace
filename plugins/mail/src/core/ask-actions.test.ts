import { describe, expect, it } from "vitest";
import { ASK_ACTIONS_MAX, parseAskActions } from "./ask-actions.ts";

describe("parseAskActions", () => {
  it("reads each kind of action", () => {
    expect(
      parseAskActions(
        [
          { type: "search", query: "from:ann has:attachment" },
          { type: "reply", message: 2, paragraphs: ["Hi Ann,", "Tuesday works."] },
          { type: "act", action: "archive", messages: [1, 3] },
        ],
        3,
      ),
    ).toEqual({
      actions: [
        { type: "search", query: "from:ann has:attachment" },
        { type: "reply", message: 2, paragraphs: ["Hi Ann,", "Tuesday works."] },
        { type: "act", action: "archive", messages: [1, 3] },
      ],
      dropped: 0,
    });
    expect(parseAskActions([{ type: "compose", paragraphs: ["Hello,\nplease send the plan."] }], 1)).toEqual({
      actions: [{ type: "compose", paragraphs: ["Hello,\nplease send the plan."] }],
      dropped: 0,
    });
  });

  it("keeps three at most and nothing that is not a list", () => {
    const four = [1, 2, 3, 4].map((i) => ({ type: "search", query: `word${i}` }));
    expect(ASK_ACTIONS_MAX).toBe(3);
    expect(parseAskActions(four, 1)).toEqual({ actions: four.slice(0, 3), dropped: 1 });
    expect(parseAskActions(undefined, 1)).toEqual({ actions: [], dropped: 0 });
    expect(parseAskActions("archive everything", 1)).toEqual({ actions: [], dropped: 1 });
  });

  it("never keeps a destructive or unknown action", () => {
    for (const action of ["delete", "spam", "trash", "send", "forward", "move", "unsubscribe"]) {
      expect(parseAskActions([{ type: "act", action, messages: [1] }], 1), action).toEqual({ actions: [], dropped: 1 });
    }
    expect(parseAskActions([{ type: "send", paragraphs: ["x"] }, { type: "delete", messages: [1] }, null, 7], 1)).toEqual({ actions: [], dropped: 4 });
  });

  it("drops numbers outside the excerpts, repeats, and an action left without messages; twenty at most", () => {
    expect(parseAskActions([{ type: "act", action: "mark_read", messages: [2, 9, 2, 0, "1", 1] }], 3)).toEqual({
      actions: [{ type: "act", action: "mark_read", messages: [2, 1] }],
      dropped: 0,
    });
    expect(parseAskActions([{ type: "act", action: "flag", messages: [7] }, { type: "reply", message: 5, paragraphs: ["x"] }], 3)).toEqual({ actions: [], dropped: 2 });
    const many = parseAskActions([{ type: "act", action: "archive", messages: Array.from({ length: 30 }, (_, i) => i + 1) }], 30);
    expect(many.actions[0]).toEqual({ type: "act", action: "archive", messages: Array.from({ length: 20 }, (_, i) => i + 1) });
  });

  it("keeps a search only when Mail's parser reads it whole: one line, 200 characters, no unknown operator", () => {
    expect(parseAskActions([{ type: "search", query: "nonsense:value words" }], 1)).toEqual({ actions: [], dropped: 1 });
    expect(parseAskActions([{ type: "search", query: "   " }], 1)).toEqual({ actions: [], dropped: 1 });
    expect(parseAskActions([{ type: "search", query: `subject:${"x".repeat(300)}` }], 1)).toEqual({ actions: [], dropped: 1 });
    expect(parseAskActions([{ type: "search", query: "invoice\nfrom:ann" }], 1)).toEqual({ actions: [{ type: "search", query: "invoice from:ann" }], dropped: 0 });
  });

  it("cuts drafted text at 4 000 characters in all and drops a draft without text", () => {
    const parsed = parseAskActions([{ type: "compose", paragraphs: ["a".repeat(3_990), "b".repeat(50), "c"] }], 1);
    expect(parsed.actions).toEqual([{ type: "compose", paragraphs: ["a".repeat(3_990), "b".repeat(10)] }]);
    expect(parseAskActions([{ type: "reply", message: 1, paragraphs: ["  ", ""] }, { type: "compose", paragraphs: "text" }], 1)).toEqual({ actions: [], dropped: 2 });
  });
});
