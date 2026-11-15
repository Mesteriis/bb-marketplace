import { describe, expect, it } from "vitest";
import {
  PROVIDER_TRACE_HEADERS,
  TRUSTED_AUTHSERV,
  UNSUBSCRIBE_HEADER_FIELDS,
  UNSUBSCRIBE_INFO_MAX_BYTES,
  offeredMethods,
  parseListUnsubscribe,
  trustOf,
  unsubscribeInfoOf,
  type HeaderLine,
  type UnsubscribeInfo,
} from "./unsubscribe.ts";

// All fixtures are synthetic: made-up domains, selectors and signature bytes.
const h = (key: string, value: string): HeaderLine => ({ key: key.toLowerCase(), value });
const lu = (value: string) => h("List-Unsubscribe", value);
const lup = (value = "List-Unsubscribe=One-Click") => h("List-Unsubscribe-Post", value);

describe("parseListUnsubscribe", () => {
  it("takes the first https and the first mailto entry", () => {
    const parsed = parseListUnsubscribe([
      lu("<mailto:leave@example.com?subject=stop>, <https://u.example.com/a?x=1>, <https://u.example.com/b>"),
      lup(),
    ]);
    expect(parsed.https).toBe("https://u.example.com/a?x=1");
    expect(parsed.mailto).toEqual({ address: "leave@example.com", subject: "stop", body: "" });
    expect(parsed.oneClick).toBe(true);
    expect(parsed.repeated).toBe(false);
  });

  it("reads at most five entries and skips entries over 2 048 characters", () => {
    const filler = Array.from({ length: 5 }, (_, i) => `<ftp://f${i}.example.com/>`).join(", ");
    expect(parseListUnsubscribe([lu(`${filler}, <https://u.example.com/x>`)]).https).toBeNull();
    const long = `<https://u.example.com/${"a".repeat(2_100)}>`;
    expect(parseListUnsubscribe([lu(`${long}, <https://u.example.com/short>`)]).https).toBe(
      "https://u.example.com/short",
    );
  });

  it("ignores http: and other schemes", () => {
    const parsed = parseListUnsubscribe([lu("<http://u.example.com/x>, <ftp://u.example.com/y>"), lup()]);
    expect(parsed.https).toBeNull();
    expect(parsed.mailto).toBeNull();
    expect(parsed.oneClick).toBe(false);
  });

  it("refuses userinfo, IP literals and ports other than 443", () => {
    for (const url of [
      "https://user:pw@u.example.com/x",
      "https://user@u.example.com/x",
      "https://192.0.2.10/x",
      "https://0x7f.1/x",
      "https://[2001:db8::1]/x",
      "https://u.example.com:8443/x",
      "https://localhost/x",
    ]) {
      expect(parseListUnsubscribe([lu(`<${url}>`)]).https, url).toBeNull();
    }
    expect(parseListUnsubscribe([lu("<https://u.example.com:443/x>")]).https).toBe("https://u.example.com/x");
  });

  it("drops mailto parameters other than subject and body and applies defaults", () => {
    const parsed = parseListUnsubscribe([
      lu("<mailto:leave@example.com?cc=other@example.org&bcc=x@example.org&in-reply-to=%3Cid%3E&body=please%20remove>"),
    ]);
    expect(parsed.mailto).toEqual({ address: "leave@example.com", subject: "unsubscribe", body: "please remove" });
  });

  it("keeps the subject on one line and caps subject and body", () => {
    const parsed = parseListUnsubscribe([
      lu(`<mailto:leave@example.com?subject=a%0D%0Ab${"c".repeat(300)}&body=${"d".repeat(1_200)}>`),
    ]);
    expect(parsed.mailto?.subject).toMatch(/^a b/);
    expect(parsed.mailto?.subject.length).toBe(200);
    expect(parsed.mailto?.body.length).toBe(1_000);
  });

  it("refuses a mailto with several addresses, a display name or a non-ASCII domain", () => {
    for (const entry of [
      "<mailto:a@example.com,b@example.com>",
      "<mailto:Name%20%3Ca@example.com%3E>",
      "<mailto:a@b\u00fccher.example>",
      "<mailto:a@b%C3%BCcher.example>",
      "<mailto:not-an-address>",
      "<mailto:a@example.com%0D%0ABcc:x@example.org>",
    ]) {
      expect(parseListUnsubscribe([lu(entry)]).mailto, entry).toBeNull();
    }
  });

  it("sets oneClick only for the exact value with an https entry", () => {
    expect(parseListUnsubscribe([lu("<https://u.example.com/x>"), lup("  List-Unsubscribe=One-Click ")]).oneClick).toBe(true);
    expect(parseListUnsubscribe([lu("<https://u.example.com/x>"), lup("List-Unsubscribe=One-Click; x")]).oneClick).toBe(false);
    expect(parseListUnsubscribe([lu("<https://u.example.com/x>"), lup("list-unsubscribe=one-click")]).oneClick).toBe(false);
    expect(parseListUnsubscribe([lu("<mailto:a@example.com>"), lup()]).oneClick).toBe(false);
    // The header name is matched case-insensitively.
    expect(parseListUnsubscribe([
      { key: "List-Unsubscribe", value: "<https://u.example.com/x>" },
      { key: "LIST-UNSUBSCRIBE-POST", value: "List-Unsubscribe=One-Click" },
    ]).oneClick).toBe(true);
  });

  it("marks repeated list headers and parses no method from two List-Unsubscribe", () => {
    const twice = parseListUnsubscribe([lu("<https://u.example.com/x>"), lu("<mailto:a@example.com>"), lup()]);
    expect(twice).toEqual({ https: null, mailto: null, oneClick: false, repeated: true });
    const twicePost = parseListUnsubscribe([lu("<https://u.example.com/x>, <mailto:a@example.com>"), lup(), lup()]);
    expect(twicePost.repeated).toBe(true);
    expect(twicePost.oneClick).toBe(false);
    expect(twicePost.mailto?.address).toBe("a@example.com");
  });
});

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

const H_COVERING = "from:to:subject:date:list-unsubscribe:list-unsubscribe-post:message-id";
const sig = (d: string, s: string, b: string, hTag = H_COVERING) =>
  h("DKIM-Signature", `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${d}; s=${s}; h=${hTag}; bh=AAAA; b=${b}`);
const ar = (id: string, results: string) => h("Authentication-Results", `${id};\r\n ${results}`);

/** A Gmail-shaped message: provider block on top, then the sender's headers. */
function gmailMessage(opts: {
  arValue?: string;
  extraTop?: HeaderLine[];
  signatures?: HeaderLine[];
  afterBlock?: HeaderLine[];
  list?: HeaderLine[];
} = {}): HeaderLine[] {
  return [
    h("Delivered-To", "owner@example.org"),
    h("Received", "by 2002:a05:0000:0000 with SMTP id x; Sun, 15 Nov 2026 10:00:00 -0800"),
    h("X-Google-Smtp-Source", "AAAAAA"),
    h("X-Received", "by 2002:a05:0000:0001 with SMTP id y"),
    h("ARC-Seal", "i=1; a=rsa-sha256; t=1; cv=none; d=google.com; s=arc-0000; b=AAAA"),
    ar("mx.google.com", opts.arValue ?? "dkim=pass header.i=@example.com header.s=sel1 header.b=AbCdEf12; spf=pass"),
    ...(opts.extraTop ?? []),
    h("Return-Path", "<bounce@example.com>"),
    h("Received", "from out.example.com (out.example.com. [192.0.2.1]) by mx.google.com"),
    ...(opts.signatures ?? [sig("example.com", "sel1", "AbCdEf12xyz")]),
    ...(opts.afterBlock ?? []),
    h("From", "News <news@example.com>"),
    h("Subject", "Weekly"),
    ...(opts.list ?? [lu("<https://u.example.com/x>"), lup()]),
  ];
}

describe("trustOf", () => {
  it("trusts a Gmail pass by header.i whose signature covers both list headers", () => {
    expect(trustOf(gmailMessage(), "gmail", "example.com", "u.example.com")).toBe("covered");
  });

  it("accepts the header.d form", () => {
    const msg = gmailMessage({ arValue: "dkim=pass (2048-bit key) header.d=example.com header.s=sel1 header.b=AbCdEf12" });
    expect(trustOf(msg, "gmail", "example.com", "u.example.com")).toBe("covered");
  });

  it("reads h= and b= with folding whitespace removed", () => {
    const folded = h(
      "DKIM-Signature",
      "v=1; a=rsa-sha256; d=example.com; s=sel1;\r\n\th=from : to:\r\n subject:list-unsubscribe:\r\n\tlist-unsubscribe-post; bh=AAAA;\r\n b=AbCd\r\n Ef12\txyz",
    );
    expect(trustOf(gmailMessage({ signatures: [folded] }), "gmail", "example.com", "u.example.com")).toBe("covered");
  });

  it("is not_covered when h= misses list-unsubscribe-post", () => {
    const msg = gmailMessage({ signatures: [sig("example.com", "sel1", "AbCdEf12xyz", "from:to:list-unsubscribe")] });
    expect(trustOf(msg, "gmail", "example.com", "u.example.com")).toBe("not_covered");
  });

  it("ignores an A-R with an untrusted authserv-id", () => {
    const msg = gmailMessage({ arValue: "spf=pass" , extraTop: [ar("relay.example.net", "dkim=pass header.d=example.com header.s=sel1")] });
    expect(trustOf(msg, "gmail", "example.com", "u.example.com")).toBe("no_dkim");
    const only = gmailMessage().filter((line) => line.key !== "authentication-results");
    expect(trustOf([ar("relay.example.net", "dkim=pass header.d=example.com"), ...only], "gmail", "example.com", null)).toBe("no_dkim");
  });

  it("ignores a trusted-id A-R below the top block", () => {
    const headers = gmailMessage({ arValue: "spf=pass" }).filter((line) => line.key !== "authentication-results");
    const forgedBelow: HeaderLine[] = [
      ...headers.slice(0, 5),
      h("Subject", "x"),
      ar("mx.google.com", "dkim=pass header.d=example.com header.s=sel1 header.b=AbCdEf12"),
      ...headers.slice(5),
    ];
    expect(trustOf(forgedBelow, "gmail", "example.com", "u.example.com")).toBe("untrusted_provider");
  });

  it("ignores a trusted-id A-R below the topmost DKIM-Signature", () => {
    const base = gmailMessage().filter((line) => line.key !== "authentication-results");
    const at = base.findIndex((line) => line.key === "dkim-signature");
    const below = [
      ...base.slice(0, at + 1),
      ar("mx.google.com", "dkim=pass header.d=example.com header.s=sel1 header.b=AbCdEf12"),
      ...base.slice(at + 1),
    ];
    expect(trustOf(below, "gmail", "example.com", "u.example.com")).toBe("untrusted_provider");
  });

  it("refuses conflicting answers: a pass and a fail for the same signature", () => {
    const msg = gmailMessage({
      extraTop: [ar("mx.google.com", "dkim=fail (bad signature) header.i=@example.com header.s=sel1 header.b=AbCdEf12")],
    });
    expect(trustOf(msg, "gmail", "example.com", "u.example.com")).toBe("no_dkim");
  });

  it("chooses the signature by s= and b= among two", () => {
    const covering = sig("example.com", "sel1", "AbCdEf12xyz");
    const other = sig("example.com", "sel2", "ZzZz99", "from:to");
    const bySelector = gmailMessage({
      arValue: "dkim=pass header.d=example.com header.s=sel2",
      signatures: [covering, other],
    });
    expect(trustOf(bySelector, "gmail", "example.com", "u.example.com")).toBe("not_covered");
    const byB = gmailMessage({
      arValue: "dkim=pass header.d=example.com header.b=AbCdEf12",
      signatures: [other, covering],
    });
    expect(trustOf(byB, "gmail", "example.com", "u.example.com")).toBe("covered");
  });

  it("needs a unique d= match when neither s nor b is given", () => {
    const one = gmailMessage({ arValue: "dkim=pass header.d=example.com" });
    expect(trustOf(one, "gmail", "example.com", "u.example.com")).toBe("covered");
    const two = gmailMessage({
      arValue: "dkim=pass header.d=example.com",
      signatures: [sig("example.com", "sel1", "AAAA"), sig("example.com", "sel2", "BBBB")],
    });
    expect(trustOf(two, "gmail", "example.com", "u.example.com")).toBe("not_covered");
  });

  it("accepts a d= that is a parent of the signer and refuses an unrelated one", () => {
    const parent = gmailMessage({ arValue: "dkim=pass header.i=@mail.example.com header.s=sel1" });
    expect(trustOf(parent, "gmail", "mail.example.com", "u.example.com")).toBe("covered");
    const unrelated = gmailMessage({
      arValue: "dkim=pass header.d=example.com header.s=sel1",
      signatures: [sig("example.org", "sel1", "AbCdEf12xyz")],
    });
    expect(trustOf(unrelated, "gmail", "example.com", "u.example.com")).toBe("not_covered");
  });

  it("checks domain sense against the signature's d=", () => {
    // Parent of the From domain.
    expect(trustOf(gmailMessage(), "gmail", "news.example.com", null)).toBe("covered");
    // Parent of the URL host only.
    expect(trustOf(gmailMessage(), "gmail", "sender.example.net", "u.example.com")).toBe("covered");
    // Unrelated to both.
    expect(trustOf(gmailMessage(), "gmail", "sender.example.net", "u.example.org")).toBe("not_covered");
    // A lookalike suffix is not a parent.
    expect(trustOf(gmailMessage(), "gmail", "badexample.com", "u.badexample.com")).toBe("not_covered");
  });

  it("is untrusted_provider for other and for icloud until its ids are pinned", () => {
    expect(TRUSTED_AUTHSERV.other).toEqual([]);
    expect(TRUSTED_AUTHSERV.icloud).toEqual([]);
    expect(trustOf(gmailMessage(), "other", "example.com", "u.example.com")).toBe("untrusted_provider");
    expect(trustOf(gmailMessage(), "icloud", "example.com", "u.example.com")).toBe("untrusted_provider");
  });

  it("is no_dkim without a passing result", () => {
    const msg = gmailMessage({ arValue: "dkim=none; spf=pass" });
    expect(trustOf(msg, "gmail", "example.com", "u.example.com")).toBe("no_dkim");
  });
});

describe("header field lists", () => {
  it("asks for the list, auth and trace fields without wildcards", () => {
    for (const name of ["From", "List-Id", "List-Unsubscribe", "List-Unsubscribe-Post", "Authentication-Results", "DKIM-Signature", "Received"]) {
      expect(UNSUBSCRIBE_HEADER_FIELDS).toContain(name);
    }
    expect(UNSUBSCRIBE_HEADER_FIELDS.some((name) => name.includes("*"))).toBe(false);
    expect(new Set(UNSUBSCRIBE_HEADER_FIELDS.map((n) => n.toLowerCase())).size).toBe(UNSUBSCRIBE_HEADER_FIELDS.length);
    expect(PROVIDER_TRACE_HEADERS.gmail).toContain("X-Google-*");
    expect(PROVIDER_TRACE_HEADERS.gmail).toContain("X-Gm-*");
  });
});

// ---------------------------------------------------------------------------
// Info and offered methods
// ---------------------------------------------------------------------------

const FROM = { name: "News", address: "news@example.com" };

describe("unsubscribeInfoOf", () => {
  it("is null without List-Unsubscribe or without headers", () => {
    expect(unsubscribeInfoOf([], "gmail", FROM)).toBeNull();
    expect(unsubscribeInfoOf([h("From", "x@example.com")], "gmail", FROM)).toBeNull();
  });

  it("builds the info with listKey from List-Id and a revealed name", () => {
    const info = unsubscribeInfoOf(
      [...gmailMessage(), h("List-Id", "\"Weekly\u200b News\" <Weekly.Example.COM>")],
      "gmail",
      FROM,
    );
    expect(info).toEqual({
      listKey: "weekly.example.com",
      listName: "Weekly News",
      https: "https://u.example.com/x",
      oneClick: true,
      mailto: null,
      trust: "covered",
    });
  });

  it("falls back to the From address and name and cuts the name to 80", () => {
    const info = unsubscribeInfoOf([lu("<mailto:leave@example.com>")], "other", {
      name: "N".repeat(100),
      address: "News@Example.com",
    });
    expect(info?.listKey).toBe("news@example.com");
    expect(info?.listName?.length).toBe(80);
    expect(info?.trust).toBe("untrusted_provider");
    expect(info?.mailto?.address).toBe("leave@example.com");
  });

  it("keeps a List-Unsubscribe with no usable method", () => {
    const info = unsubscribeInfoOf([lu("<http://u.example.com/x>")], "gmail", FROM);
    expect(info).not.toBeNull();
    expect(info?.https).toBeNull();
    expect(info?.mailto).toBeNull();
  });

  it("marks repeated headers not_covered", () => {
    const twoLu = unsubscribeInfoOf(
      gmailMessage({ list: [lu("<https://u.example.com/x>"), lu("<mailto:a@example.com>"), lup()] }),
      "gmail",
      FROM,
    );
    expect(twoLu?.trust).toBe("not_covered");
    expect(twoLu?.mailto).toBeNull();
    const twoPost = unsubscribeInfoOf(
      gmailMessage({ list: [lu("<https://u.example.com/x>, <mailto:a@example.com>"), lup(), lup()] }),
      "gmail",
      FROM,
    );
    expect(twoPost?.trust).toBe("not_covered");
    expect(twoPost?.oneClick).toBe(false);
  });

  it("is null when the serialized info is over the size cap", () => {
    expect(UNSUBSCRIBE_INFO_MAX_BYTES).toBe(4 * 1024);
    // A 2 022-character entry whose quotes the URL parser percent-encodes into a 6 KiB href.
    const huge = unsubscribeInfoOf([lu(`<https://u.example.com/${'"'.repeat(2_000)}>`)], "gmail", FROM);
    expect(huge).toBeNull();
    const small = unsubscribeInfoOf([lu(`<https://u.example.com/${"a".repeat(2_000)}>`)], "gmail", FROM);
    expect(small).not.toBeNull();
  });
});

describe("offeredMethods", () => {
  const base: UnsubscribeInfo = {
    listKey: "news@example.com",
    listName: null,
    https: "https://u.example.com/x",
    oneClick: true,
    mailto: { address: "leave@example.com", subject: "unsubscribe", body: "" },
    trust: "covered",
  };

  it("offers one-click only when it is covered", () => {
    expect(offeredMethods(base, "news@example.com").oneClick).toEqual({ host: "u.example.com" });
    expect(offeredMethods({ ...base, trust: "not_covered" }, "news@example.com").oneClick).toBeNull();
    expect(offeredMethods({ ...base, oneClick: false }, "news@example.com").oneClick).toBeNull();
  });

  it("flags a mailto that is not at the sender's domain or a parent of it", () => {
    expect(offeredMethods(base, "news@example.com").mailto).toEqual({
      address: "leave@example.com",
      subject: "unsubscribe",
      foreignDomain: false,
    });
    expect(offeredMethods(base, "news@mail.example.com").mailto?.foreignDomain).toBe(false);
    expect(offeredMethods(base, "news@example.org").mailto?.foreignDomain).toBe(true);
    expect(offeredMethods({ ...base, mailto: null }, "news@example.com").mailto).toBeNull();
  });
});
