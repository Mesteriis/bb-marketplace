import { describe, expect, it } from "vitest";
import {
  RULES_MAX,
  RULE_CAPS,
  alertClass,
  capVerdict,
  ruleCandidates,
  mailRuleMatches,
  validateRule,
  type Rule,
  type RuleRow,
} from "./mail-rules.ts";

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  id: "r_1",
  name: "CI failures",
  enabled: true,
  match: { dev: { source: "github", kind: "ci", state: "failed" } },
  projectId: "p_demo",
  template: "Look at the failure.",
  mode: "prepare",
  ...overrides,
});

const row = (overrides: Partial<RuleRow> = {}): RuleRow => ({
  accountId: "acc_1",
  fromAddress: "notifications@github.com",
  listId: "demo.example-org.github.com",
  subject: "[example-org/demo] Run failed: CI - main",
  dev: { source: "github", repo: "github.com/example-org/demo", kind: "ci", state: "failed", ref: null },
  bulk: true,
  ...overrides,
});

describe("validateRule", () => {
  const input = { name: "CI", match: { from: ["a@example.org"] }, template: "Do it", mode: "prepare" as const, projectId: "p" };

  it("accepts a rule with one matcher", () => {
    expect(validateRule(input)).toEqual({ ok: true });
    expect(validateRule({ ...input, match: { domains: ["example.org"] } })).toEqual({ ok: true });
    expect(validateRule({ ...input, match: { list: "demo.example-org.github.com" } })).toEqual({ ok: true });
    expect(validateRule({ ...input, match: { subjectWords: ["deploy"] } })).toEqual({ ok: true });
    expect(validateRule({ ...input, match: { dev: { source: "monitoring" } } })).toEqual({ ok: true });
  });

  it("needs a matcher beyond accounts", () => {
    expect(validateRule({ ...input, match: {} }).ok).toBe(false);
    expect(validateRule({ ...input, match: { accounts: ["acc_1"] } }).ok).toBe(false);
    expect(validateRule({ ...input, match: { dev: {} } }).ok).toBe(false);
  });

  it("keeps the bounds", () => {
    expect(validateRule({ ...input, name: "" }).ok).toBe(false);
    expect(validateRule({ ...input, name: "n".repeat(80) }).ok).toBe(true);
    expect(validateRule({ ...input, name: "n".repeat(81) }).ok).toBe(false);
    expect(validateRule({ ...input, template: "t".repeat(4_001) }).ok).toBe(false);
    expect(validateRule({ ...input, match: { from: Array.from({ length: 21 }, (_, i) => `a${i}@example.org`) } }).ok).toBe(false);
    expect(validateRule({ ...input, match: { from: ["not an address"] } }).ok).toBe(false);
    expect(validateRule({ ...input, match: { domains: Array.from({ length: 21 }, (_, i) => `d${i}.example.org`) } }).ok).toBe(false);
    expect(validateRule({ ...input, match: { domains: ["a@b"] } }).ok).toBe(false);
    expect(validateRule({ ...input, match: { subjectWords: Array.from({ length: 11 }, (_, i) => `w${i}`) } }).ok).toBe(false);
    expect(validateRule({ ...input, match: { subjectWords: ["two words"] } }).ok).toBe(false);
    expect(validateRule({ ...input, match: { list: "<bad list>" } }).ok).toBe(false);
  });

  it("needs the confirmation for start mode", () => {
    expect(validateRule({ ...input, mode: "start" })).toEqual({ ok: false, reason: expect.stringMatching(/confirm/i) });
    expect(validateRule({ ...input, mode: "start", confirmedStart: true })).toEqual({ ok: true });
  });

  it("allows 50 rules", () => {
    expect(RULES_MAX).toBe(50);
  });
});

describe("mailRuleMatches", () => {
  it("matches every given field", () => {
    expect(mailRuleMatches(rule(), row())).toBe(true);
    expect(mailRuleMatches(rule(), row({ dev: { source: "github", repo: null, kind: "ci", state: "passed", ref: null } }))).toBe(false);
    expect(mailRuleMatches(rule(), row({ dev: null }))).toBe(false);
    expect(mailRuleMatches(rule({ enabled: false }), row())).toBe(false);
  });

  it("matches a dev repo case-insensitively", () => {
    expect(mailRuleMatches(rule({ match: { dev: { repo: "github.com/Example-Org/Demo" } } }), row())).toBe(true);
  });

  it("matches from addresses and domains, subdomains included", () => {
    const person = row({ fromAddress: "Ops@Mail.Example.org", bulk: false, dev: null, listId: null, subject: "hi" });
    expect(mailRuleMatches(rule({ match: { from: ["ops@mail.example.org"] } }), person)).toBe(true);
    expect(mailRuleMatches(rule({ match: { domains: ["example.org"] } }), person)).toBe(true);
    expect(mailRuleMatches(rule({ match: { domains: ["ample.org"] } }), person)).toBe(false);
    expect(mailRuleMatches(rule({ match: { domains: ["other.org"] } }), person)).toBe(false);
  });

  it("matches whole subject words, case-folded, all of them", () => {
    const person = row({ bulk: false, dev: null, subject: "Deploy FAILED on prod-eu" });
    expect(mailRuleMatches(rule({ match: { subjectWords: ["deploy", "failed"] } }), person)).toBe(true);
    expect(mailRuleMatches(rule({ match: { subjectWords: ["deploy", "passed"] } }), person)).toBe(false);
    expect(mailRuleMatches(rule({ match: { subjectWords: ["dep"] } }), person)).toBe(false);
  });

  it("matches the List-Id and limits accounts", () => {
    expect(mailRuleMatches(rule({ match: { list: "demo.example-org.github.com" } }), row())).toBe(true);
    expect(mailRuleMatches(rule({ match: { list: "demo.example-org.github.com", accounts: ["acc_2"] } }), row())).toBe(false);
    expect(mailRuleMatches(rule({ match: { list: "demo.example-org.github.com", accounts: ["acc_1"] } }), row())).toBe(true);
  });

  it("skips bulk mail unless the rule matches on dev or list", () => {
    expect(mailRuleMatches(rule({ match: { domains: ["github.com"] } }), row())).toBe(false);
    expect(mailRuleMatches(rule({ match: { domains: ["github.com"] } }), row({ bulk: false }))).toBe(true);
    expect(mailRuleMatches(rule({ match: { list: "demo.example-org.github.com" } }), row())).toBe(true);
  });
});

describe("ruleCandidates", () => {
  it("is newInbox minus returning, never inserted", () => {
    const outcome = { newInbox: ["m1", "m2", "m3"], returning: ["m2"], inserted: ["m1", "m2", "m3", "m9"] };
    expect(ruleCandidates(outcome)).toEqual(["m1", "m3"]);
    expect(ruleCandidates({ newInbox: [], returning: [], inserted: ["m9"] } as never)).toEqual([]);
  });
});

describe("capVerdict", () => {
  const counts = { ruleHour: 0, ruleDay: 0, allDay: 0, conversationDay: 0 };

  it("allows below every cap and holds at each edge", () => {
    expect(RULE_CAPS).toEqual({ perRuleHour: 3, perRuleDay: 10, allDay: 20 });
    expect(capVerdict(counts)).toBe("ok");
    expect(capVerdict({ ...counts, ruleHour: 2, ruleDay: 9, allDay: 19 })).toBe("ok");
    expect(capVerdict({ ...counts, ruleHour: 3 })).toBe("capped");
    expect(capVerdict({ ...counts, ruleDay: 10 })).toBe("capped");
    expect(capVerdict({ ...counts, allDay: 20 })).toBe("capped");
    expect(capVerdict({ ...counts, conversationDay: 1 })).toBe("capped");
  });
});

describe("alertClass", () => {
  it("is a rule matching alerts or monitoring mail", () => {
    expect(alertClass(rule({ match: { dev: { kind: "alert" } } }))).toBe(true);
    expect(alertClass(rule({ match: { dev: { source: "monitoring" } } }))).toBe(true);
    expect(alertClass(rule())).toBe(false);
    expect(alertClass(rule({ match: { from: ["a@example.org"] } }))).toBe(false);
  });
});
