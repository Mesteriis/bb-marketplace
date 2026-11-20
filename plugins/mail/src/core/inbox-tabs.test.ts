import { describe, expect, it } from "vitest";

import { OTHER_QUERY, TAB_LIBRARY, tabConditions, tabMatch, tabQueryProblem, teamDomains, type InboxTab } from "./inbox-tabs.ts";

const now = new Date("2026-11-19T10:00:00.000Z");
const tab = (id: string, query: string, position = 0): InboxTab => ({ id, name: id, query, position });

describe("inbox tabs", () => {
  it("reads a tab's condition as search conditions", () => {
    expect(tabConditions("from:vip has:attachment", now)).toEqual({
      ok: true,
      conditions: [
        { field: "sender", value: "vip", negated: false },
        { field: "has", value: "attachment", negated: false },
      ],
    });
  });

  it("takes free text as one more condition, after the operators", () => {
    expect(tabConditions("invoice", now)).toEqual({ ok: true, conditions: [{ field: "text", value: "invoice", negated: false }] });
    expect(tabConditions("weekly from:vip report", now)).toEqual({
      ok: true,
      conditions: [
        { field: "sender", value: "vip", negated: false },
        { field: "text", value: "weekly report", negated: false },
      ],
    });
  });

  it("refuses an unknown operator, a bad value, a folder, nothing and too much", () => {
    expect(tabConditions("foo:bar", now)).toEqual({ ok: false, reason: "unknown_operator" });
    expect(tabConditions("is:devops", now)).toEqual({ ok: false, reason: "bad_value" });
    expect(tabConditions("in:trash", now)).toEqual({ ok: false, reason: "unknown_operator" });
    expect(tabConditions("  ", now)).toEqual({ ok: false, reason: "empty" });
    expect(tabConditions(`from:${"a".repeat(500)}`, now)).toEqual({ ok: false, reason: "too_long" });
  });

  it("Other matches what none of the other tabs holds, skipping a tab that no longer parses", () => {
    const tabs = [tab("vip", "from:vip"), tab("broken", "foo:bar"), tab("dev", "is:dev"), tab("other", OTHER_QUERY)];
    expect(tabMatch(tabs[3]!, tabs, now)).toEqual({
      kind: "none",
      of: [[{ field: "sender", value: "vip", negated: false }], [{ field: "is", value: "dev", negated: false }]],
    });
    expect(tabMatch(tabs[1]!, tabs, now)).toBeNull();
    expect(tabQueryProblem(OTHER_QUERY, now)).toBeNull();
    expect(tabQueryProblem("is:other from:vip", now)).toBe("bad_value");
  });

  it("every tab of the library has a condition that can be saved, and ids are unique", () => {
    for (const entry of TAB_LIBRARY) expect(tabQueryProblem(entry.query, now), entry.id).toBeNull();
    expect(new Set(TAB_LIBRARY.map((entry) => entry.id)).size).toBe(TAB_LIBRARY.length);
    expect(TAB_LIBRARY.map((entry) => entry.name)).toEqual(expect.arrayContaining(["VIP", "Team", "People", "Dev", "Newsletters", "Notifications", "Calendar", "Attachments", "Other"]));
  });

  it("the team is the owner's own domains without public mail", () => {
    expect([...teamDomains(["owner@Example.org", "me@gmail.com", "alias@corp.example.net", "broken"])].sort()).toEqual(["corp.example.net", "example.org"]);
  });

  it("the library's Newsletters tab holds mailing lists too, and needs no categories", () => {
    expect(TAB_LIBRARY.find((entry) => entry.id === "newsletters")?.query).toBe("is:newsletter");
  });
});
