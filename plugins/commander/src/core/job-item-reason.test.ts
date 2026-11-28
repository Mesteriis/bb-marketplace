import { expect, test } from "vitest";
import { OperationJob } from "./model.ts";

const items = OperationJob.shape.items;

test("an item keeps its code and reason as literals", () => {
  const item = { outcome: "failed", error: "x", code: "unsupported", reason: "link_not_supported" };
  expect(items.parse([item])).toEqual([item]);
});

test("a reason that does not belong to the item's code, or comes without a code, is refused", () => {
  expect(items.safeParse([{ outcome: "failed", error: "x", code: "unsupported", reason: "archive_copy" }]).success).toBe(false);
  expect(items.safeParse([{ outcome: "failed", error: "x", reason: "link_escapes" }]).success).toBe(false);
  expect(items.safeParse([{ outcome: "failed", error: "x", code: "unsupported", reason: "nope" }]).success).toBe(false);
});

test("an item without a pair stays valid (older stored jobs)", () => {
  expect(items.parse([{ outcome: "done", error: null }])).toEqual([{ outcome: "done", error: null }]);
});
