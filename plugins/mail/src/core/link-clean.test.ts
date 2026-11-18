import { describe, expect, it } from "vitest";
import { TRACKING_PARAMS, cleanLink, cleanUrlsInText } from "./link-clean.ts";
import { buildKnownDomains } from "./sender-disguise.ts";

const on = { clean: true };
const off = { clean: false };
const url = (href: string, text: string | null = null, options: Parameters<typeof cleanLink>[2] = on) => cleanLink(href, text, options);

describe("cleanLink: parameters", () => {
  it("removes every listed parameter, case-insensitively", () => {
    const names = [
      "utm_source", "UTM_Medium", "utm_anything", "fbclid", "gclid", "gbraid", "wbraid", "dclid", "msclkid", "yclid",
      "ysclid", "igshid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsCtaTracking",
      "mkt_tok", "oly_anon_id", "oly_enc_id", "vero_id", "_kx", "trk", "trkCampaign", "sc_cid", "s_cid", "ref_src",
    ];
    for (const name of names) {
      const result = url(`https://shop.example.com/p?${name}=v1&id=7`);
      expect(result?.url, name).toBe("https://shop.example.com/p?id=7");
      expect(result?.removedParams, name).toBe(1);
    }
    expect(TRACKING_PARAMS.length).toBeGreaterThan(20);
  });

  it("keeps the other parameters byte for byte and in order", () => {
    const result = url("https://shop.example.com/p?a=%2B1&utm_source=x&b=c+d&sig=AbC%3D%3D&utm_medium=y&z=#frag");
    expect(result?.url).toBe("https://shop.example.com/p?a=%2B1&b=c+d&sig=AbC%3D%3D&z=#frag");
    expect(result?.removedParams).toBe(2);
  });

  it("drops a query left empty and keeps the fragment", () => {
    expect(url("https://shop.example.com/p?utm_source=x&fbclid=y#top")?.url).toBe("https://shop.example.com/p#top");
    expect(url("https://shop.example.com/p?utm_source=x")?.url).toBe("https://shop.example.com/p");
    expect(url("https://shop.example.com/p#a?utm_source=x")?.url).toBe("https://shop.example.com/p#a?utm_source=x");
  });

  it("leaves a clean link exactly as it was", () => {
    const href = "https://shop.example.com/p?q=a%20b&x=1";
    expect(url(href)).toMatchObject({ url: href, original: href, removedParams: 0, unwrapped: false, needsDialog: false });
  });

  it("does nothing with clean off", () => {
    const href = "https://www.google.com/url?q=https%3A%2F%2Fshop.example.com%2Fp%3Futm_source%3Dx";
    expect(url(href, null, off)).toMatchObject({ url: href, removedParams: 0, unwrapped: false });
    expect(url("https://shop.example.com/p?utm_source=x", null, off)?.url).toBe("https://shop.example.com/p?utm_source=x");
  });
});

describe("cleanLink: wrappers", () => {
  it("unwraps Google, Outlook SafeLinks and Facebook, then cleans the target", () => {
    expect(url("https://www.google.com/url?sa=t&q=https%3A%2F%2Fshop.example.com%2Fp%3Fid%3D1%26utm_source%3Dx")).toMatchObject({
      url: "https://shop.example.com/p?id=1",
      unwrapped: true,
      removedParams: 1,
      host: "shop.example.com",
    });
    expect(url("https://google.co.uk/url?url=https://shop.example.com/a")?.url).toBe("https://shop.example.com/a");
    expect(url("https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fshop.example.com%2Fb&data=x&reserved=0")?.url).toBe(
      "https://shop.example.com/b",
    );
    expect(url("https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example.com%2Fc&h=AT0")?.url).toBe("https://shop.example.com/c");
    expect(url("https://lm.facebook.com/l.php?u=http%3A%2F%2Fshop.example.com%2Fd")?.url).toBe("http://shop.example.com/d");
  });

  it("follows one level only", () => {
    const inner = encodeURIComponent("https://www.google.com/url?q=https%3A%2F%2Fshop.example.com%2F");
    const result = url(`https://l.facebook.com/l.php?u=${inner}`);
    expect(result?.url).toBe("https://www.google.com/url?q=https%3A%2F%2Fshop.example.com%2F");
    expect(result?.unwrapped).toBe(true);
  });

  it("does not unwrap to javascript:, mailto: or garbage", () => {
    for (const target of ["javascript%3Aalert(1)", "mailto%3Ax%40example.com", "%E0%A4%A", "not-a-url"]) {
      const href = `https://www.google.com/url?q=${target}`;
      expect(url(href)?.url, target).toBe(href);
      expect(url(href)?.unwrapped, target).toBe(false);
    }
    const safe = "https://x.safelinks.protection.outlook.com/?url=mailto%3Ax%40example.com";
    expect(url(safe)?.url).toBe(safe);
  });

  it("matches wrapper hosts exactly", () => {
    for (const href of [
      "https://google.evil.example/url?q=https://shop.example.com/",
      "https://notgoogle.com/url?q=https://shop.example.com/",
      "https://www.google.com.evil.example/url?q=https://shop.example.com/",
      "https://safelinks.protection.outlook.com.evil.example/?url=https://shop.example.com/",
      "https://x.facebook.com/l.php?u=https://shop.example.com/",
      "https://www.google.com/search?q=https://shop.example.com/",
    ]) {
      expect(url(href)?.unwrapped, href).toBe(false);
    }
  });
});

describe("cleanLink: schemes", () => {
  it("refuses everything but http, https and mailto", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///etc/hosts", "ftp://example.com/", "custom-app://open", "", "not a url"]) {
      expect(url(href), href).toBeNull();
    }
  });

  it("returns mailto unchanged", () => {
    expect(url("mailto:x@example.com?subject=hi&utm_source=y")).toMatchObject({
      url: "mailto:x@example.com?subject=hi&utm_source=y",
      removedParams: 0,
      needsDialog: false,
    });
  });
});

describe("cleanLink: checks on the final URL", () => {
  it("flags text that names another site", () => {
    const result = url("https://example.net.evil.example/login", "www.example.com");
    expect(result?.deceptive).toEqual({ says: "www.example.com" });
    expect(result?.needsDialog).toBe(true);
    expect(url("https://login.example.com/x", "https://www.example.com")?.deceptive).toBeNull();
    expect(url("https://example.net/x", "Click here")?.deceptive).toBeNull();
    expect(url("https://example.net/x", "Visit example.com today")?.deceptive).toBeNull();
    expect(url("https://example.net/x", `https://example.com/${"a".repeat(400)}`)?.deceptive).toBeNull();
  });

  it("judges the unwrapped target, not the wrapper", () => {
    expect(url("https://www.google.com/url?q=https%3A%2F%2Fwww.example.com%2F", "www.example.com")?.needsDialog).toBe(false);
    expect(url("https://www.google.com/url?q=https%3A%2F%2Fevil.example%2F", "www.example.com")?.deceptive).toEqual({
      says: "www.example.com",
    });
  });

  it("names a listed tracking redirect instead of opening the dialog", () => {
    const result = url("https://u123.ct.sendgrid.net/ls/click?upn=abc", "www.example.com");
    expect(result?.trackingHost).toBe("u123.ct.sendgrid.net");
    expect(result?.deceptive).toBeNull();
    expect(result?.needsDialog).toBe(false);
  });

  it("notes punycode without a dialog, opens one for mixed alphabets", () => {
    const rf = url("https://xn--e1afmkfd.xn--p1ai/");
    expect(rf?.unusualHost).toBe("punycode");
    expect(rf?.needsDialog).toBe(false);
    const mixed = url(`https://sh${"\u043e"}p.example.org/`);
    expect(mixed?.host.startsWith("xn--")).toBe(true);
    expect(mixed?.unusualHost).toBe("mixed_script");
    expect(mixed?.needsDialog).toBe(true);
  });

  it("opens the dialog for a lookalike of a known domain", () => {
    const known = buildKnownDomains(["example.com"]);
    const result = url("https://login.examp1e.com/", null, { clean: true, known });
    expect(result?.lookalike).toBe("example.com");
    expect(result?.needsDialog).toBe(true);
    expect(url("https://www.example.com/", null, { clean: true, known })?.lookalike).toBeNull();
  });
});

describe("cleanUrlsInText", () => {
  it("cleans every http(s) URL in plain text and leaves the rest", () => {
    expect(cleanUrlsInText("See https://shop.example.com/p?utm_source=x&id=1. And <https://www.google.com/url?q=https%3A%2F%2Fa.example.org%2F>!")).toBe(
      "See https://shop.example.com/p?id=1. And <https://a.example.org/>!",
    );
    expect(cleanUrlsInText("mailto:x@example.com and (https://shop.example.com/p?fbclid=1)")).toBe(
      "mailto:x@example.com and (https://shop.example.com/p)",
    );
    expect(cleanUrlsInText("no links here")).toBe("no links here");
  });
});

// Slice 3i review, findings 4 and 5.
describe("review: deceptive text hidden by invisible characters or punctuation", () => {
  it("opens the dialog through zero-width, bidi and format characters", () => {
    for (const text of ["example.com\u200b", "\u200eexample.com", "exa\u200dmple.com", "\u202aexample.com\u202c", "\ufeffexample.com\u2069"]) {
      const result = url("https://evil.example/x", text);
      expect(result?.deceptive, JSON.stringify(text)).toEqual({ says: "example.com" });
      expect(result?.needsDialog, JSON.stringify(text)).toBe(true);
    }
  });

  it("opens the dialog through surrounding punctuation and arrows", () => {
    for (const text of ["example.com \u203a", "https://example.com/login \u2192", "www.example.com!", "\u00abwww.example.com\u00bb", "<https://example.com>", "(example.com)"]) {
      expect(url("https://evil.example/x", text)?.needsDialog, JSON.stringify(text)).toBe(true);
    }
  });

  it("finds a URL or www. host written inside short text, but not a bare word with a dot", () => {
    expect(url("https://evil.example/x", "Sign in at https://www.example.com/login now")?.deceptive).toEqual({ says: "www.example.com" });
    expect(url("https://evil.example/x", "Visit www.example.com today")?.deceptive).toEqual({ says: "www.example.com" });
    expect(url("https://example.com/x", "Sign in at https://www.example.com/login now")?.needsDialog).toBe(false);
    // A bare host only counts as the whole text: "report.pdf" in a sentence is not a site.
    expect(url("https://files.example.net/x", "Download report.pdf here")?.deceptive).toBeNull();
    expect(url("https://example.net/x", "Visit example.com today")?.deceptive).toBeNull();
  });
});

describe("review: an unwrapped target never brings control or format characters back", () => {
  it("keeps the wrapper when its decoded target holds a control, bidi or space character", () => {
    for (const encoded of ["%0A", "%0D", "%1B%5B2J", "%7F", "%C2%85", "%E2%80%AE", "%20"]) {
      const href = `https://www.google.com/url?q=https%3A%2F%2Fx.example.org%2Fa${encoded}b&sa=D`;
      const result = url(href);
      expect(result?.unwrapped, encoded).toBe(false);
      expect(result?.url, encoded).toBe(href);
    }
  });

  it("cleans text without letting a wrapper add a line", () => {
    const out = cleanUrlsInText("see https://www.google.com/url?q=https%3A%2F%2Fx.example.org%2F%0AFrom%3A%20boss%1B%5B2J&sa=D end");
    expect(out).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/);
    expect(out).toContain("https://www.google.com/url?q=");
  });
});
