import test from "node:test";
import assert from "node:assert/strict";
import { ago } from "../src/core/i18n/time.ts";

const now = Date.parse("2026-11-28T12:00:00Z");
test("how long ago, in the words of each language", () => {
  assert.equal(ago("ru", now, "2026-11-28T11:59:30Z"), "только что");
  assert.equal(ago("ru", now, "2026-11-28T11:48:00Z"), "12 мин");
  assert.equal(ago("ru", now, "2026-11-28T10:00:00Z"), "2 ч");
  assert.equal(ago("ru", now, "2026-11-27T10:00:00Z"), "1 день");
  assert.equal(ago("ru", now, "2026-11-26T10:00:00Z"), "2 дня");
  assert.equal(ago("ru", now, "2026-11-23T10:00:00Z"), "5 дней");
  assert.equal(ago("en", now, "2026-11-28T11:48:00Z"), "12 min");
  assert.equal(ago("en", now, "2026-11-27T10:00:00Z"), "1 day");
  assert.equal(ago("en", now, "2026-11-28T11:59:59Z"), "just now");
  assert.equal(ago("en", now, null), "");
  assert.equal(ago("en", now, "not a date"), "");
  // A clock a little ahead of the forge's is not "in the future".
  assert.equal(ago("en", now, "2026-11-28T12:00:30Z"), "just now");
});

test("a duration in the words of each language: seconds under a minute, minutes and seconds under an hour, then hours and minutes", async () => {
  const { duration } = await import("../src/core/i18n/time.ts");
  assert.equal(duration("ru", 8), "8 с");
  assert.equal(duration("ru", 134), "2 мин 14 с");
  assert.equal(duration("ru", 120), "2 мин 0 с");
  assert.equal(duration("ru", 3720), "1 ч 2 мин");
  assert.equal(duration("en", 134), "2m 14s");
  assert.equal(duration("en", 3720), "1h 2m");
  assert.equal(duration("en", 0), "0s");
  assert.equal(duration("en", null), "");
});
