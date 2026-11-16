import { describe, expect, it } from "vitest";
import {
  autoImagesAllowed,
  authenticityLines,
  orgDomain,
  readStoredCheck,
  senderCheckOf,
  senderCheckSummary,
  type SenderCheck,
} from "./sender-check.ts";
import type { MailAddress, SpecialUse } from "./model.ts";
import { parseAuthResults, trustedAuthResults, type HeaderLine } from "./unsubscribe.ts";

// All fixtures are synthetic, hand-written in Gmail's format: made-up domains,
// selectors and addresses on example.com / example.org / example.net.
const h = (key: string, value: string): HeaderLine => ({ key: key.toLowerCase(), value });
const from: MailAddress = { name: "Billing", address: "billing@example.com" };
const inbox: { folderRole: SpecialUse | null; outbox?: boolean } = { folderRole: "inbox" };

const ar = (body: string, id = "mx.google.com") => h("Authentication-Results", `${id};\r\n       ${body}`);
const DKIM_PASS = "dkim=pass header.i=@example.com header.s=sel1";
const SPF_PASS = "spf=pass (google.com: domain of bounce@mail.example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@mail.example.com";
const SPF_FAIL = "spf=fail (google.com: domain of bounce@example.com does not designate 192.0.2.9 as permitted sender) smtp.mailfrom=bounce@example.com";

/** A Gmail top block above the message's own headers. */
function message(results: HeaderLine[], rest: HeaderLine[] = []): HeaderLine[] {
  return [
    h("Delivered-To", "owner@example.net"),
    h("Received", "by 2002:a05:6000:1:b0:1 with SMTP id x; Mon, 16 Nov 2026 10:00:00 -0800"),
    h("X-Google-Smtp-Source", "AGHT+synthetic"),
    h("Return-Path", "<bounce@mail.example.com>"),
    h("Received", "from mail.example.com (mail.example.com. [192.0.2.1]) by mx.google.com"),
    h("Received-SPF", "pass (google.com: domain of bounce@mail.example.com designates 192.0.2.1 as permitted sender)"),
    ...results,
    h("DKIM-Signature", "v=1; a=rsa-sha256; d=example.com; s=sel1; h=from:subject; b=c3ludGhldGlj"),
    h("From", "Billing <billing@example.com>"),
    ...rest,
  ];
}

const check = (headers: HeaderLine[], preset: "gmail" | "icloud" | "other" = "gmail", sender = from, options = inbox) =>
  senderCheckOf(headers, preset, sender, options);

describe("senderCheckOf: states", () => {
  it("is ok on DMARC pass and failed on DMARC fail", () => {
    const pass = check(message([ar(`${DKIM_PASS};\r\n ${SPF_PASS};\r\n dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com`)]));
    expect(pass.state).toBe("ok");
    expect(pass.authserv).toBe("mx.google.com");
    expect(pass.dmarc).toEqual({ result: "pass", domain: "example.com" });
    expect(pass.dkim).toEqual([{ result: "pass", domain: "example.com", aligned: true }]);
    expect(pass.spf).toEqual({ result: "pass", domain: "mail.example.com" });

    const failed = check(message([ar(`dkim=none; ${SPF_FAIL}; dmarc=fail (p=REJECT sp=REJECT dis=REJECT) header.from=example.com`)]));
    expect(failed.state).toBe("failed");
    expect(senderCheckSummary(failed)).toBe("DMARC failed");
  });

  it("fails on SPF fail without DMARC only when no aligned DKIM passed", () => {
    expect(check(message([ar(SPF_FAIL)])).state).toBe("failed");
    expect(senderCheckSummary(check(message([ar(SPF_FAIL)])))).toBe("SPF failed and no aligned DKIM signature passed");
    expect(check(message([ar(`${DKIM_PASS}; ${SPF_FAIL}`)])).state).toBe("ok");
    // A pass from a signer that is not aligned with From does not help.
    expect(check(message([ar(`dkim=pass header.i=@example.org header.s=s; ${SPF_FAIL}`)])).state).toBe("failed");
  });

  it("claims nothing for softfail, neutral and none", () => {
    for (const body of [
      "spf=softfail (google.com: transitioning) smtp.mailfrom=bounce@example.com",
      "spf=neutral smtp.mailfrom=bounce@example.com",
      "spf=none smtp.mailfrom=bounce@example.com; dkim=none",
      "dmarc=none header.from=example.com",
      "dmarc=bestguesspass header.from=example.com",
    ]) {
      const result = check(message([ar(body)]));
      expect(result.state, body).toBe("unchecked");
      expect(result.basis, body).toBe("results");
    }
  });

  it("uses relaxed alignment by organizational domain", () => {
    const sub = check(message([ar("dkim=pass header.i=@news.example.com header.s=s1")]), "gmail", {
      name: null,
      address: "a@mail.example.com",
    });
    expect(sub.state).toBe("ok");
    expect(sub.dkim[0]?.aligned).toBe(true);
  });
});

describe("senderCheckOf: forged results", () => {
  it("ignores a trusted-id A-R below the trace block", () => {
    const headers = message(
      [ar(`dkim=none; ${SPF_FAIL}; dmarc=fail header.from=example.com`)],
      [ar("dkim=pass header.i=@example.com; dmarc=pass header.from=example.com")],
    );
    expect(check(headers).state).toBe("failed");
  });

  it("ignores a trusted-id A-R below the topmost DKIM-Signature", () => {
    const headers = [
      h("Received", "by mx.google.com"),
      h("DKIM-Signature", "v=1; d=example.com; s=sel1; b=c3ludGhldGlj"),
      ar("dmarc=pass header.from=example.com"),
      h("From", "billing@example.com"),
    ];
    const result = check(headers);
    expect(result.state).toBe("unchecked");
    expect(result.basis).toBe("no_results");
  });

  it("lets only the topmost trusted header decide when a forged block sits above From", () => {
    // The sender wrote a Received and a trusted-id A-R; with no DKIM-Signature
    // they sit inside the trace block, below the provider's own header.
    const headers = [
      h("Received", "by mx.google.com"),
      ar(`${SPF_FAIL}; dmarc=fail header.from=example.com`),
      h("Received", "from forged.example.org"),
      ar("dkim=pass header.i=@example.com; dmarc=pass header.from=example.com"),
      h("From", "billing@example.com"),
    ];
    const result = check(headers);
    expect(result.state).toBe("failed");
    expect(result.alsoPresent).toBe(1);
  });

  it("lets the worst DMARC result win and ignores DMARC for another domain", () => {
    expect(check(message([ar("dmarc=pass header.from=example.com; dmarc=fail header.from=example.com")])).state).toBe("failed");
    expect(check(message([ar("dmarc=fail header.from=example.com; dmarc=pass header.from=example.com")])).state).toBe("failed");
    const other = check(message([ar("dmarc=pass header.from=example.org")]));
    expect(other.state).toBe("unchecked");
    expect(other.dmarc).toBeNull();
    expect(other.otherDmarc).toEqual([{ result: "pass", domain: "example.org" }]);
    expect(check(message([ar("dmarc=pass")])).state).toBe("unchecked");
  });

  it("cannot be injected through a quoted smtp.mailfrom", () => {
    // A quoted local part holding `;` must not start a new entry.
    const quoted = check(message([ar(`spf=fail smtp.mailfrom="x;dmarc=pass header.from=example.com;"@example.org; dmarc=fail header.from=example.com`)]));
    expect(quoted.state).toBe("failed");
    const injected = check(message([ar(`spf=fail smtp.mailfrom="x;dmarc=pass header.from=example.com;"@example.org`)]));
    expect(injected.dmarc).toBeNull();
    expect(injected.state).toBe("failed");
  });

  it("cannot be injected through a quoted `)` inside a comment", () => {
    const value =
      'spf=fail (google.com: domain of "a);dmarc=pass header.from=example.com;x=(y"@example.org does not designate 192.0.2.9) smtp.mailfrom=x@example.org';
    const result = check(message([ar(value)]));
    expect(result.dmarc).toBeNull();
    expect(result.state).toBe("failed");
  });

  it("survives an unbalanced `)` and never claims ok when a quote is left open", () => {
    const stray = check(message([ar("dkim=pass header.i=@example.com (a) ) b; dmarc=pass header.from=example.com")]));
    expect(stray.state).toBe("ok");
    const open = check(message([ar('dkim=pass header.i=@example.com; spf=none smtp.mailfrom="x@example.org; dmarc=pass header.from=example.com')]));
    expect(open.state).not.toBe("ok");
    expect(open.malformed).toBe(true);
  });

  it("ignores an untrusted authserv-id", () => {
    const result = check(message([ar("dmarc=fail header.from=example.com", "mx.example.org")]));
    expect(result.state).toBe("unchecked");
    expect(result.basis).toBe("no_results");
    expect(result.authserv).toBeNull();
  });
});

describe("senderCheckOf: who is checked", () => {
  const failing = message([ar(`${SPF_FAIL}; dmarc=fail header.from=example.com`)]);

  it("does not read other servers or iCloud before its id is pinned", () => {
    for (const preset of ["other", "icloud"] as const) {
      const result = check(failing, preset);
      expect(result.state).toBe("unchecked");
      expect(result.basis).toBe("provider");
      expect(senderCheckSummary(result)).toBe("Not checked: Mail does not read this server's results");
    }
  });

  it("leaves Sent, Drafts and outbox copies unchecked", () => {
    expect(check(failing, "gmail", from, { folderRole: "sent" }).basis).toBe("own");
    expect(check(failing, "gmail", from, { folderRole: "drafts" }).state).toBe("unchecked");
    expect(check(failing, "gmail", from, { folderRole: null, outbox: true }).basis).toBe("own");
  });

  it("judges an Inbox message forged from the owner's own address", () => {
    const own = { name: "Me", address: "owner@example.com" };
    expect(check(failing, "gmail", own, inbox).state).toBe("failed");
  });

  it("never claims ok with two From lines or two mailboxes", () => {
    const passing = `${DKIM_PASS}; dmarc=pass header.from=example.com`;
    const twoLines = check(message([ar(passing)], [h("From", "other@example.org")]));
    expect(twoLines.state).toBe("unchecked");
    expect(twoLines.multipleFrom).toBe(true);
    const twoBoxes = [...message([ar(passing)])];
    twoBoxes[twoBoxes.length - 1] = h("From", "billing@example.com, other@example.org");
    expect(check(twoBoxes).state).toBe("unchecked");
    const quotedComma = [...message([ar(passing)])];
    quotedComma[quotedComma.length - 1] = h("From", '"Billing, Team" <billing@example.com>');
    expect(check(quotedComma).state).toBe("ok");
    expect(check(message([ar(`${SPF_FAIL}; dmarc=fail header.from=example.com`)], [h("From", "x@example.org")])).state).toBe(
      "failed",
    );
  });
});

describe("parseAuthResults bounds", () => {
  it("reads at most 4 KB of a value and marks it", () => {
    const long = `mx.google.com; dmarc=pass header.from=example.com; x=${"a".repeat(5_000)}`;
    const parsed = parseAuthResults(long);
    expect(parsed?.malformed).toBe(true);
    expect(check(message([h("Authentication-Results", long)])).state).toBe("unchecked");
  });

  it("reads at most 20 entries", () => {
    const many = Array.from({ length: 25 }, () => "dkim=none").join("; ");
    const parsed = parseAuthResults(`mx.google.com; ${many}; dmarc=fail header.from=example.com`);
    expect(parsed?.entries.length).toBe(20);
    expect(parsed?.malformed).toBe(true);
  });

  it("keeps the properties of every method", () => {
    const parsed = parseAuthResults(`mx.google.com; ${DKIM_PASS}; ${SPF_PASS}; dmarc=pass header.from=Example.COM; arc=pass`);
    expect(parsed?.entries.map((entry) => entry.method)).toEqual(["dkim", "spf", "dmarc"]);
    expect(parsed?.entries[1]?.smtpMailfrom).toBe("bounce@mail.example.com");
    expect(parsed?.entries[2]?.headerFrom).toBe("Example.COM");
  });

  it("trustedAuthResults keeps the top-block rule and says when the preset trusts nobody", () => {
    expect(trustedAuthResults(message([ar("dmarc=pass header.from=example.com")]), "other")).toBeNull();
    const found = trustedAuthResults(message([ar("dmarc=pass header.from=example.com")]), "gmail");
    expect(found?.counted.length).toBe(1);
    expect(found?.elsewhere).toBe(false);
  });

  it("caps the DKIM entries kept at five", () => {
    const many = Array.from({ length: 7 }, (_, i) => `dkim=pass header.i=@s${i}.example.org`).join("; ");
    expect(check(message([ar(many)])).dkim.length).toBe(5);
  });
});

describe("orgDomain", () => {
  it("takes two labels, or three under a country second level", () => {
    expect(orgDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(orgDomain("example.com")).toBe("example.com");
    expect(orgDomain("mail.Example.COM.")).toBe("example.com");
    expect(orgDomain("news.example.com.au")).toBe("example.com.au");
    expect(orgDomain("example.uk")).toBe("example.uk");
    expect(orgDomain("a.example.travel")).toBe("example.travel");
    expect(orgDomain("localhost")).toBe("localhost");
  });

  it("keeps xn-- labels and punycodes Unicode input", () => {
    expect(orgDomain("mail.xn--e1afmkfd.xn--p1ai")).toBe("xn--e1afmkfd.xn--p1ai");
    expect(orgDomain(`mail.${"\u043f\u0440\u0438\u043c\u0435\u0440"}.${"\u0440\u0444"}`)).toBe("xn--e1afmkfd.xn--p1ai");
  });
});

describe("readStoredCheck", () => {
  const stored = (value: SenderCheck) => JSON.stringify(value);

  it("reads NULL and garbage as unknown", () => {
    expect(readStoredCheck(null, "gmail").state).toBe("unknown");
    expect(readStoredCheck("{not json", "gmail").state).toBe("unknown");
    expect(readStoredCheck(JSON.stringify({ state: "ok" }), "gmail").state).toBe("unknown");
  });

  it("round-trips a stored check", () => {
    const value = check(message([ar(`${DKIM_PASS}; dmarc=pass header.from=example.com`)]));
    expect(readStoredCheck(stored(value), "gmail")).toEqual(value);
  });

  it("rereads a check stored before the preset's ids were pinned", () => {
    const before = check(message([ar("dmarc=fail header.from=example.com")]), "icloud");
    expect(before.basis).toBe("provider");
    // icloud still has no ids: the stored verdict stands.
    expect(readStoredCheck(stored(before), "icloud").state).toBe("unchecked");
    // Read against a preset that has ids now (gmail stands in for a pinned iCloud).
    expect(readStoredCheck(stored(before), "gmail").state).toBe("unknown");
    // Own mail and a trusted preset without results are not rechecked forever.
    const own = check(message([]), "gmail", from, { folderRole: "sent" });
    expect(readStoredCheck(stored(own), "gmail").state).toBe("unchecked");
    const none = check(message([]), "gmail");
    expect(none.basis).toBe("no_results");
    expect(readStoredCheck(stored(none), "gmail").state).toBe("unchecked");
  });
});

describe("autoImagesAllowed", () => {
  const lookalike = { kind: "lookalike" };
  const named = { kind: "name_shows_address" };
  const replyTo = { kind: "reply_to_elsewhere" };
  const mixed = { kind: "mixed_script" };

  it("allows only ok or unchecked senders without a disguise", () => {
    expect(autoImagesAllowed({ state: "ok" }, [])).toBe(true);
    expect(autoImagesAllowed({ state: "unchecked" }, [])).toBe(true);
    expect(autoImagesAllowed({ state: "ok" }, [replyTo, mixed])).toBe(true);
    expect(autoImagesAllowed({ state: "failed" }, [])).toBe(false);
    expect(autoImagesAllowed({ state: "unknown" }, [])).toBe(false);
    expect(autoImagesAllowed(null, [])).toBe(false);
    expect(autoImagesAllowed({ state: "ok" }, [lookalike])).toBe(false);
    expect(autoImagesAllowed({ state: "unchecked" }, [named])).toBe(false);
  });
});

describe("summary and Details lines", () => {
  it("never claims a positive result in the summary", () => {
    const ok = check(message([ar(`${DKIM_PASS}; dmarc=pass header.from=example.com`)]));
    expect(senderCheckSummary(ok)).toBeNull();
    expect(senderCheckSummary(readStoredCheck(null, "gmail"))).toBe("Not checked yet");
  });

  it("writes the provider's results as fixed-format lines", () => {
    const ok = check(message([ar(`${DKIM_PASS}; ${SPF_PASS}; dmarc=pass header.from=example.com`)]));
    expect(authenticityLines(ok)).toEqual([
      "SPF pass (mail.example.com)",
      "DKIM pass (example.com, aligned)",
      "DMARC pass (example.com)",
    ]);
    expect(authenticityLines(check(message([]), "other"))).toEqual(["Not checked: Mail does not read this server's results"]);
    expect(authenticityLines(readStoredCheck(null, "gmail"))).toEqual(["Not checked yet"]);
  });
});
