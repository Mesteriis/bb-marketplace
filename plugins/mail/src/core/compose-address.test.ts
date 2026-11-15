import { describe, expect, it } from "vitest";
import {
  dedupeAddresses,
  parseAddress,
  sameAddress,
  splitAddressList,
  toAsciiDomain,
} from "./compose-address.ts";

function ok(input: string) {
  const result = parseAddress(input);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to parse: ${result.problem}`);
  return result.value;
}

function problem(input: string) {
  const result = parseAddress(input);
  return result.ok ? "ok" : result.problem;
}

describe("parseAddress", () => {
  it.each([
    ["anna@example.org", { name: null, address: "anna@example.org" }],
    ["  anna@example.org  ", { name: null, address: "anna@example.org" }],
    ["<anna@example.org>", { name: null, address: "anna@example.org" }],
    ["Anna Lind <anna@example.org>", { name: "Anna Lind", address: "anna@example.org" }],
    ['"Lind, Anna" <anna@example.org>', { name: "Lind, Anna", address: "anna@example.org" }],
    ['"Anna \\"Ann\\" Lind" <anna@example.org>', { name: 'Anna "Ann" Lind', address: "anna@example.org" }],
    ['"" <anna@example.org>', { name: null, address: "anna@example.org" }],
    ["Анна <anna@example.org>", { name: "Анна", address: "anna@example.org" }],
    ["first.last+tag@sub.example.com", { name: null, address: "first.last+tag@sub.example.com" }],
    ["o'brien@example.com", { name: null, address: "o'brien@example.com" }],
    ["Anna@EXAMPLE.Org", { name: null, address: "Anna@example.org" }],
  ])("parses %j", (input, value) => {
    expect(ok(input)).toEqual(value);
  });

  it("punycodes an IDN domain", () => {
    expect(ok("anna@bücher.example").address).toBe("anna@xn--bcher-kva.example");
    expect(ok("Анна <anna@почта.example>").address).toBe("anna@xn--80a1acny.example");
  });

  it("refuses a non-ASCII local part (no SMTPUTF8)", () => {
    expect(problem("анна@example.org")).toBe("non_ascii_local");
    expect(problem("Anna <jösé@example.org>")).toBe("non_ascii_local");
  });

  it.each([
    "anna@example.org\r\nBcc: eve@example.net",
    "anna@example.org\nBcc: eve@example.net",
    "anna\r@example.org",
    "anna@exam\u0000ple.org",
    "Anna\r\nBcc: eve@example.net <anna@example.org>",
    '"Anna\nX" <anna@example.org>',
    "anna\t@example.org",
    "anna%0d%0aBcc:eve@example.org",
    "Anna%0D%0A <anna@example.org>",
    "anna%00@example.org",
  ])("refuses control characters in %j", (input) => {
    expect(problem(input)).toBe("control");
  });

  it.each([
    "",
    "   ",
  ])("calls %j empty", (input) => {
    expect(problem(input)).toBe("empty");
  });

  it("refuses an input over 320 characters", () => {
    expect(problem(`${"a".repeat(64)}@${"b".repeat(250)}.example`)).toBe("too_long");
    expect(problem(`${"N".repeat(310)} <anna@example.org>`)).toBe("too_long");
  });

  it.each([
    "anna",
    "anna@",
    "@example.org",
    "a@b",
    "anna@@example.org",
    "anna@example..org",
    "anna@-example.org",
    "anna@example-.org",
    "anna@example.org.",
    ".anna@example.org",
    "anna.@example.org",
    "an..na@example.org",
    "anna lind@example.org",
    "anna@exa mple.org",
    "anna@[192.0.2.1]",
    "anna@192.0.2.1",
    "anna@example.org:25",
    "anna@example.org/path",
    "Anna, Lind <anna@example.org>",
    "Anna; Lind <anna@example.org>",
    'Anna "Ann" <anna@example.org>',
    "Anna <anna@example.org",
    "Anna anna@example.org>",
    "Anna <anna@example.org> extra",
    "<<anna@example.org>>",
    "anna@example.org, bob@example.org",
    '"unterminated <anna@example.org>',
    '"q"@example.org',
    `${"a".repeat(65)}@example.org`,
    `anna@${"b".repeat(64)}.example`,
  ])("refuses the malformed %j", (input) => {
    expect(problem(input)).toBe("syntax");
  });
});

describe("toAsciiDomain", () => {
  it("lowercases ASCII domains and punycodes IDNs", () => {
    expect(toAsciiDomain("Example.ORG")).toBe("example.org");
    expect(toAsciiDomain("bücher.example")).toBe("xn--bcher-kva.example");
  });

  it("throws on a domain the URL parser refuses", () => {
    expect(() => toAsciiDomain("exa mple.org")).toThrow();
    expect(() => toAsciiDomain("")).toThrow();
  });
});

describe("splitAddressList", () => {
  it("splits on commas, semicolons and newlines", () => {
    expect(
      splitAddressList("anna@example.org, bob@example.org;carl@example.org\ndora@example.org\r\n"),
    ).toEqual(["anna@example.org", "bob@example.org", "carl@example.org", "dora@example.org"]);
  });

  it("keeps separators inside quotes and angle brackets", () => {
    expect(
      splitAddressList('"Lind, Anna" <anna@example.org>; "Bob; B" <bob@example.org>, x <a,b>'),
    ).toEqual(['"Lind, Anna" <anna@example.org>', '"Bob; B" <bob@example.org>', "x <a,b>"]);
  });

  it("drops empty pieces", () => {
    expect(splitAddressList(" , ;\n")).toEqual([]);
  });
});

describe("sameAddress and dedupeAddresses", () => {
  it("compares the whole address case-insensitively without Gmail folding", () => {
    expect(sameAddress("Anna@Example.org", "anna@example.org")).toBe(true);
    expect(sameAddress(" anna@example.org ", "anna@example.org")).toBe(true);
    expect(sameAddress("a.nna@example.org", "anna@example.org")).toBe(false);
    expect(sameAddress("anna+x@example.org", "anna@example.org")).toBe(false);
  });

  it("keeps the first of each address, in order", () => {
    expect(
      dedupeAddresses([
        { name: "Anna", address: "anna@example.org" },
        { name: null, address: "bob@example.org" },
        { name: "Other", address: "ANNA@example.org" },
      ]),
    ).toEqual([
      { name: "Anna", address: "anna@example.org" },
      { name: null, address: "bob@example.org" },
    ]);
  });
});
