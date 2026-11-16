import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  CATEGORY_RULES_MAX,
  CATEGORY_UNDO_MS,
  CategoryUndoBook,
  categoryRuleRefusal,
  localCategory,
  ruleMatches,
  type CategoryRule,
} from "./categories.ts";

const sentTo = new Set(["friend@example.com"]);

describe("localCategory", () => {
  it("follows the local rules and never says bills", () => {
    expect(CATEGORIES).toEqual(["bills", "notifications", "personal", "newsletters"]);
    expect(localCategory({ bulk: true, listKey: "news.example.com", fromAddress: "news@example.com" }, sentTo)).toBe("newsletters");
    expect(localCategory({ bulk: true, listKey: null, fromAddress: "billing@example.com" }, sentTo)).toBe("notifications");
    expect(localCategory({ bulk: false, listKey: null, fromAddress: "noreply@example.org" }, sentTo)).toBe("notifications");
    expect(localCategory({ bulk: false, listKey: null, fromAddress: "Friend@Example.com" }, sentTo)).toBe("personal");
    expect(localCategory({ bulk: true, listKey: null, fromAddress: "friend@example.com" }, sentTo)).toBe("notifications");
    expect(localCategory({ bulk: false, listKey: null, fromAddress: "stranger@example.com" }, sentTo)).toBeNull();
    expect(localCategory({ bulk: null, listKey: null, fromAddress: "invoice@example.com" }, sentTo)).toBeNull();
  });
});

describe("ruleMatches", () => {
  const rules: CategoryRule[] = [
    { id: "r1", kind: "domain", value: "example.com", category: "notifications", createdAt: "2026-11-16T00:00:00Z" },
    { id: "r2", kind: "domain", value: "billing.example.com", category: "bills", createdAt: "2026-11-16T00:00:00Z" },
    { id: "r3", kind: "address", value: "ann@billing.example.com", category: "personal", createdAt: "2026-11-16T00:00:00Z" },
  ];

  it("prefers the address, then the most specific domain", () => {
    expect(ruleMatches("Ann@Billing.Example.com", rules)?.id).toBe("r3");
    expect(ruleMatches("bot@billing.example.com", rules)?.id).toBe("r2");
    expect(ruleMatches("bot@mail.example.com", rules)?.id).toBe("r1");
    expect(ruleMatches("bot@notexample.com", rules)).toBeNull();
    expect(ruleMatches("not an address", rules)).toBeNull();
    expect(ruleMatches("bot@example.com", [])).toBeNull();
  });
});

describe("categoryRuleRefusal", () => {
  it("refuses public mail domains and invalid values", () => {
    expect(CATEGORY_RULES_MAX).toBe(500);
    expect(categoryRuleRefusal("domain", "gmail.com")).toMatch(/public mail domain/);
    expect(categoryRuleRefusal("domain", "yahoo.co.uk")).toMatch(/public mail domain/);
    expect(categoryRuleRefusal("address", "someone@gmail.com")).toBeNull();
    expect(categoryRuleRefusal("domain", "example.com")).toBeNull();
    expect(categoryRuleRefusal("domain", "nodot")).toBe("Not a valid domain");
    expect(categoryRuleRefusal("address", "nobody")).toBe("Not a valid address");
  });
});

describe("CategoryUndoBook", () => {
  const previous = [{ accountId: "a1", dedupKey: "d1", category: null, source: null }];

  it("hands a record back once within ten minutes", () => {
    let n = 0;
    const book = new CategoryUndoBook(() => `u${++n}`);
    const start = new Date("2026-11-16T10:00:00Z");
    const id = book.record(previous, start);
    expect(book.take(id, new Date(start.getTime() + CATEGORY_UNDO_MS - 1))).toEqual(previous);
    expect(book.take(id, start)).toBeNull();
  });

  it("forgets a record after ten minutes", () => {
    const book = new CategoryUndoBook(() => "u1");
    const start = new Date("2026-11-16T10:00:00Z");
    book.record(previous, start);
    expect(book.take("u1", new Date(start.getTime() + CATEGORY_UNDO_MS))).toBeNull();
  });
});
