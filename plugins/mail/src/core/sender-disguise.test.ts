import { describe, expect, it } from "vitest";
import {
  KNOWN_DOMAINS_MAX,
  buildKnownDomains,
  disguiseWarnings,
  isLookalikeHost,
  scriptsOf,
  skeleton,
  type DisguiseInput,
} from "./sender-disguise.ts";

// Invented domains only. Look-alike letters are written as \u escapes.
const CYR_A = "\u0430";
const CYR_O = "\u043e";
const GREEK_O = "\u03bf";

const known = buildKnownDomains(["example.com", "mail.example.org", "partner-example.net", "gmail.com", "examplebank.co.uk"]);
const own = new Set(["owner@example.net"]);

const input = (overrides: Partial<DisguiseInput> = {}): DisguiseInput => ({
  from: { name: "Billing", address: "billing@example.com" },
  replyTo: [],
  bulk: false,
  listId: null,
  check: { state: "ok" },
  known,
  own,
  ...overrides,
});
const kinds = (warnings: { kind: string }[]) => warnings.map((warning) => warning.kind);

describe("skeleton and scripts", () => {
  it("maps look-alike letters and ASCII pairs and drops hyphens", () => {
    expect(skeleton(`ex${CYR_A}mple`)).toBe("example");
    expect(skeleton(`g${CYR_O}${GREEK_O}gle`)).toBe("google");
    expect(skeleton("examp1e")).toBe("example");
    expect(skeleton("g00gle")).toBe("google");
    expect(skeleton("rnicrosoft")).toBe("microsoft");
    expect(skeleton("vvikipedia")).toBe("wikipedia");
    expect(skeleton("Ex-Ample")).toBe("example");
  });

  it("names the alphabets of a label", () => {
    expect([...scriptsOf("example")]).toEqual(["latin"]);
    expect([...scriptsOf(`ex${CYR_A}mple`)].sort()).toEqual(["cyrillic", "latin"]);
    expect([...scriptsOf("123-456")]).toEqual([]);
  });
});

describe("disguiseWarnings: Reply-To", () => {
  it("warns when replies go to an unknown other domain", () => {
    const warnings = disguiseWarnings(input({ replyTo: [{ name: null, address: "help@Example-Support.net" }] }));
    expect(warnings).toEqual([{ kind: "reply_to_elsewhere", addresses: ["help@example-support.net"] }]);
  });

  it("does not warn for the same organization, a known domain or an own address", () => {
    expect(disguiseWarnings(input({ replyTo: [{ name: null, address: "help@support.example.com" }] }))).toEqual([]);
    expect(disguiseWarnings(input({ replyTo: [{ name: null, address: "x@example.org" }] }))).toEqual([]);
    expect(disguiseWarnings(input({ replyTo: [{ name: null, address: "owner@example.net" }] }))).toEqual([]);
  });

  it("lets a list point replies at its own domain unless the check failed", () => {
    const list = { bulk: true, listId: "news.list-host.example", replyTo: [{ name: null, address: "talk@list-host.example" }] };
    expect(disguiseWarnings(input(list))).toEqual([]);
    expect(kinds(disguiseWarnings(input({ ...list, check: { state: "failed" } })))).toEqual(["reply_to_elsewhere"]);
    expect(kinds(disguiseWarnings(input({ ...list, replyTo: [{ name: null, address: "x@third.example" }] })))).toEqual([
      "reply_to_elsewhere",
    ]);
  });

  it("judges at most ten Reply-To addresses", () => {
    const replyTo = [
      ...Array.from({ length: 10 }, (_, i) => ({ name: null, address: `r${i}@example.com` })),
      { name: null, address: "x@elsewhere.example" },
    ];
    expect(disguiseWarnings(input({ replyTo }))).toEqual([]);
  });
});

describe("disguiseWarnings: lookalike", () => {
  it("flags a confusable or one-edit copy of a known domain with the same TLD", () => {
    expect(disguiseWarnings(input({ from: { name: null, address: "a@examp1e.com" } }))).toEqual([
      { kind: "lookalike", domain: "examp1e.com", like: "example.com" },
    ]);
    const cyrillic = disguiseWarnings(input({ from: { name: null, address: `a@ex${CYR_A}mple.com` } }));
    expect(kinds(cyrillic)).toEqual(["lookalike", "mixed_script"]);
    expect(cyrillic[0]).toMatchObject({ like: "example.com" });
    expect((cyrillic[0] as { domain: string }).domain.startsWith("xn--")).toBe(true);
    expect(disguiseWarnings(input({ from: { name: null, address: "a@exampel.com" } }))).toEqual([
      { kind: "lookalike", domain: "exampel.com", like: "example.com" },
    ]);
    expect(disguiseWarnings(input({ from: { name: null, address: "a@gmai1.com" } }))).toEqual([
      { kind: "lookalike", domain: "gmai1.com", like: "gmail.com" },
    ]);
    expect(disguiseWarnings(input({ from: { name: null, address: "a@exampIebank.co.uk" } }))).toEqual([
      { kind: "lookalike", domain: "examplebank.co.uk".replace("pl", "pi"), like: "examplebank.co.uk" },
    ]);
  });

  it("does not flag short labels by one edit, other TLDs or known domains", () => {
    const short = buildKnownDomains(["abcd.com"]);
    expect(disguiseWarnings(input({ known: short, from: { name: null, address: "a@abce.com" } }))).toEqual([]);
    expect(disguiseWarnings(input({ from: { name: null, address: "a@exampel.de" } }))).toEqual([]);
    expect(disguiseWarnings(input({ from: { name: null, address: "a@news.example.com" } }))).toEqual([]);
    expect(disguiseWarnings(input({ from: { name: null, address: "a@unrelated.com" } }))).toEqual([]);
  });

  it("answers the link dialog's question with the same rule", () => {
    expect(isLookalikeHost("login.examp1e.com", known)).toBe("example.com");
    expect(isLookalikeHost("www.example.com", known)).toBeNull();
    expect(isLookalikeHost("other.example", known)).toBeNull();
  });
});

describe("disguiseWarnings: alphabets and names", () => {
  it("flags a domain that mixes alphabets in one label, shown in ASCII", () => {
    const warnings = disguiseWarnings(input({ known: buildKnownDomains([]), from: { name: null, address: `a@sh${CYR_O}p.example` } }));
    expect(kinds(warnings)).toEqual(["mixed_script"]);
    expect((warnings[0] as { domain: string }).domain).toMatch(/^xn--/);
  });

  it("does not flag a domain in one other alphabet", () => {
    const rf = `\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444`;
    expect(disguiseWarnings(input({ known: buildKnownDomains([]), from: { name: null, address: `a@${rf}` } }))).toEqual([]);
  });

  it("flags a display name that shows another address", () => {
    expect(disguiseWarnings(input({ from: { name: "ceo@example.com", address: "x@example.org" } }))).toEqual([
      { kind: "name_shows_address", shown: "ceo@example.com", actual: "x@example.org" },
    ]);
    expect(disguiseWarnings(input({ from: { name: "Billing (billing@example.com)", address: "billing@example.com" } }))).toEqual([]);
    expect(disguiseWarnings(input({ from: { name: "Team at example.com", address: "x@example.org" } }))).toEqual([]);
  });

  it("keeps the fixed order and one warning per kind", () => {
    const warnings = disguiseWarnings(
      input({
        from: { name: "boss@example.com", address: `a@ex${CYR_A}mple.com` },
        replyTo: [{ name: null, address: "x@elsewhere.example" }],
      }),
    );
    expect(kinds(warnings)).toEqual(["reply_to_elsewhere", "lookalike", "mixed_script", "name_shows_address"]);
  });

  it("warns about nothing for own mail", () => {
    expect(disguiseWarnings(input({ check: { state: "unchecked", basis: "own" }, from: { name: null, address: "a@examp1e.com" } }))).toEqual([]);
  });
});

describe("known domains", () => {
  it("keeps organizational domains and stops at the cap", () => {
    const many = buildKnownDomains(Array.from({ length: KNOWN_DOMAINS_MAX + 10 }, (_, i) => `d${i}.example.org`));
    expect(many.size).toBe(1);
    const distinct = buildKnownDomains(Array.from({ length: KNOWN_DOMAINS_MAX + 10 }, (_, i) => `name${i}.example`));
    expect(distinct.size).toBe(KNOWN_DOMAINS_MAX);
  });

  it("checks a 200-message thread against 5 000 known domains quickly", () => {
    const seeded = buildKnownDomains(Array.from({ length: 5_000 }, (_, i) => `correspondent${i}.com`));
    const messages = Array.from({ length: 200 }, (_, i) =>
      input({
        known: seeded,
        from: { name: `Sender ${i}`, address: `s${i}@correspondant${i}.com` },
        replyTo: [{ name: null, address: `r${i}@reply${i}.example` }],
      }),
    );
    const started = performance.now();
    const results = messages.map((message) => disguiseWarnings(message));
    const elapsed = performance.now() - started;
    expect(results.every((warnings) => warnings.some((warning) => warning.kind === "lookalike"))).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });
});
