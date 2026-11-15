import { describe, expect, it } from "vitest";
import {
  BLOCK_RULES_MAX,
  PUBLIC_MAIL_DOMAINS,
  blockCandidates,
  blockRefusal,
  isPublicMailDomain,
  matchesBlock,
  normalizeBlockValue,
  type BlockRule,
} from "./blocking.ts";

const rule = (kind: BlockRule["kind"], value: string, id = `r-${value}`): BlockRule => ({
  id,
  kind,
  value,
  createdAt: "2026-11-15T10:00:00.000Z",
});

describe("normalizeBlockValue", () => {
  it("lower-cases and punycodes the domain", () => {
    expect(normalizeBlockValue("address", " News@Example.COM ")).toBe("news@example.com");
    expect(normalizeBlockValue("domain", "B\u00fccher.Example")).toBe("xn--bcher-kva.example");
    expect(normalizeBlockValue("address", "x@b\u00fccher.example")).toBe("x@xn--bcher-kva.example");
    expect(normalizeBlockValue("domain", "@example.org")).toBe("example.org");
  });

  it("throws on values that are not an address or a domain", () => {
    expect(() => normalizeBlockValue("address", "no-at-sign")).toThrow();
    expect(() => normalizeBlockValue("domain", "a b.example")).toThrow();
    expect(() => normalizeBlockValue("domain", "")).toThrow();
  });
});

describe("matchesBlock", () => {
  const rules = [rule("address", "spam@example.org"), rule("domain", "example.com"), rule("domain", "xn--bcher-kva.example")];

  it("matches an address exactly, case-insensitively", () => {
    expect(matchesBlock("Spam@Example.org", rules)?.id).toBe("r-spam@example.org");
    expect(matchesBlock("ham@example.org", rules)).toBeNull();
  });

  it("matches a domain and its subdomains label-wise", () => {
    expect(matchesBlock("a@example.com", rules)?.id).toBe("r-example.com");
    expect(matchesBlock("a@mail.example.com", rules)?.id).toBe("r-example.com");
    expect(matchesBlock("a@badexample.com", rules)).toBeNull();
    expect(matchesBlock("a@example.com.example.net", rules)).toBeNull();
  });

  it("matches a unicode From against a punycode rule", () => {
    expect(matchesBlock("a@b\u00fccher.example", rules)?.id).toBe("r-xn--bcher-kva.example");
  });

  it("matches nothing for an unusable address or no rules", () => {
    expect(matchesBlock("nonsense", rules)).toBeNull();
    expect(matchesBlock("a@example.com", [])).toBeNull();
  });
});

describe("public mail domains", () => {
  it("knows the exact entries", () => {
    for (const domain of ["gmail.com", "icloud.com", "proton.me", "mail.ru", "fastmail.com", "Gmail.COM"]) {
      expect(isPublicMailDomain(domain), domain).toBe(true);
    }
    expect(PUBLIC_MAIL_DOMAINS).toContain("googlemail.com");
  });

  it("matches the patterns with one or two labels after the name", () => {
    for (const domain of ["yahoo.com", "yahoo.co.uk", "gmx.de", "gmx.net", "outlook.com.br", "hotmail.fr", "live.com", "yandex.ru", "zohomail.com"]) {
      expect(isPublicMailDomain(domain), domain).toBe(true);
    }
    for (const domain of ["yahoo.example.com", "example.com", "mail.yahoo.com", "yahoo", "notgmail.com", "gmail.com.example.net"]) {
      expect(isPublicMailDomain(domain), domain).toBe(false);
    }
  });
});

describe("blockCandidates", () => {
  it("offers the domain unless it is a public mail domain", () => {
    expect(blockCandidates("News@Mail.Example.com")).toEqual({ address: "news@mail.example.com", domain: "mail.example.com" });
    expect(blockCandidates("someone@gmail.com")).toEqual({ address: "someone@gmail.com", domain: null });
    expect(blockCandidates("someone@yahoo.co.uk").domain).toBeNull();
  });
});

describe("blockRefusal", () => {
  const own = ["owner@example.org", "Me@Gmail.com"];

  it("refuses an own address and a domain that holds one", () => {
    expect(blockRefusal("address", "OWNER@example.org", own)).toBe("You cannot block your own address");
    expect(blockRefusal("domain", "example.org", own)).toBe("You cannot block your own address");
    expect(blockRefusal("address", "colleague@example.org", own)).toBeNull();
  });

  it("refuses a public mail domain but not an address there", () => {
    expect(blockRefusal("domain", "gmail.com", own)).not.toBeNull();
    expect(blockRefusal("domain", "yahoo.co.uk", [])).not.toBeNull();
    expect(blockRefusal("address", "stranger@gmail.com", own)).toBeNull();
  });

  it("refuses values that are not an address or a domain", () => {
    expect(blockRefusal("address", "nope", own)).not.toBeNull();
    expect(blockRefusal("domain", "a b", own)).not.toBeNull();
  });

  it("keeps a rule cap", () => {
    expect(BLOCK_RULES_MAX).toBe(1_000);
  });
});
