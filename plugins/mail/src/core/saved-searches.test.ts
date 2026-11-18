import { describe, expect, it } from "vitest";
import { SAVED_SEARCHES_MAX, SAVED_SEARCH_NAME_MAX, SAVED_SEARCH_QUERY_MAX, validSavedSearch } from "./saved-searches.ts";

describe("validSavedSearch", () => {
  it("accepts a name and query, trimmed", () => {
    expect(validSavedSearch({ name: " Bills ", query: " from:billing@example.org " })).toEqual({
      ok: true,
      name: "Bills",
      query: "from:billing@example.org",
    });
  });

  it("enforces the bounds", () => {
    expect(SAVED_SEARCHES_MAX).toBe(50);
    expect(validSavedSearch({ name: "", query: "x" })).toEqual({ ok: false, reason: "name" });
    expect(validSavedSearch({ name: "a".repeat(SAVED_SEARCH_NAME_MAX + 1), query: "x" })).toEqual({ ok: false, reason: "name" });
    expect(validSavedSearch({ name: "a".repeat(60), query: "x" })).toMatchObject({ ok: true });
    expect(validSavedSearch({ name: "n", query: "  " })).toEqual({ ok: false, reason: "query" });
    expect(validSavedSearch({ name: "n", query: "q".repeat(SAVED_SEARCH_QUERY_MAX + 1) })).toEqual({ ok: false, reason: "query" });
    expect(validSavedSearch({ name: "n", query: "q".repeat(500) })).toMatchObject({ ok: true });
  });

  it("removes control characters from the name", () => {
    expect(validSavedSearch({ name: "Bi\u0007lls", query: "x" })).toMatchObject({ ok: true, name: "Bills" });
    expect(validSavedSearch({ name: "\u0001", query: "x" })).toEqual({ ok: false, reason: "name" });
  });
});
