import { describe, expect, it } from "vitest";
import {
  HEADERS_MAX_PAIRS,
  HEADERS_TRUNCATED,
  STRUCTURE_MAX_LINES,
  decodeEncodedWords,
  describeStructure,
  formatSize,
  headerValue,
  normalizeMessageId,
  parseStructuredHeader,
  readHeaders,
} from "./headers.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const MULTIPART = [
  "From: Sender <sender@example.org>",
  "To: owner@example.org",
  "Subject: Invented report",
  "Message-ID: <report-1@example.org>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/alternative; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Invented text body.",
  "--inner",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Invented html body.</p>",
  "--inner--",
  "",
  "--outer",
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "SW52ZW50ZWQ=",
  "--outer--",
  "",
].join("\r\n");

describe("readHeaders", () => {
  it("returns the header fields in order, unfolded", () => {
    const raw = bytes(
      "Received: from a.example.org\r\n\tby b.example.org\r\nSubject: Invented\r\n  folded subject\r\nX-Empty:\r\n\r\nBody: not a header\r\n",
    );
    expect(readHeaders(raw)).toEqual([
      ["Received", "from a.example.org by b.example.org"],
      ["Subject", "Invented folded subject"],
      ["X-Empty", ""],
    ]);
  });

  it("decodes RFC 2047 words, joining adjacent ones", () => {
    const raw = bytes(
      "Subject: =?UTF-8?B?0J/RgNC40LI=?= =?UTF-8?B?0LXRgg==?= and =?ISO-8859-1?Q?caf=E9_au_lait?=\r\n\r\n",
    );
    expect(readHeaders(raw)).toEqual([["Subject", "Привет and café au lait"]]);
  });

  it("keeps a <script> subject as plain text and strips control and bidi characters", () => {
    const raw = bytes(
      "Subject: <script>alert(1)</script>\r\nX-Spoof: abc‮fdp.exe\u0007\r\n\r\n",
    );
    expect(readHeaders(raw)).toEqual([
      ["Subject", "<script>alert(1)</script>"],
      ["X-Spoof", "abcfdp.exe"],
    ]);
  });

  it("works on LF-only messages", () => {
    expect(readHeaders(bytes("Subject: one\nX-Two: two\n\nbody\n"))).toEqual([
      ["Subject", "one"],
      ["X-Two", "two"],
    ]);
  });

  it("caps names and values and ends with the truncated marker", () => {
    const long = "x".repeat(300);
    const raw = bytes(`A: ${long}\r\nB: ${long}\r\nC: ${long}\r\n\r\n`);
    const pairs = readHeaders(raw, 500);
    expect(pairs).toEqual([["A", long], ["B", "x".repeat(500 - 301 - 1)], HEADERS_TRUNCATED]);
  });

  it("leaves a word in an unknown charset as it was", () => {
    expect(decodeEncodedWords("=?x-unknown?Q?abc?= ok")).toBe("=?x-unknown?Q?abc?= ok");
  });
});

describe("headerValue / normalizeMessageId", () => {
  it("finds the first field case-insensitively, undecoded", () => {
    const raw = bytes("message-id:\r\n <a@example.org>\r\nMessage-ID: <b@example.org>\r\n\r\n");
    expect(headerValue(raw, "Message-ID")).toBe("<a@example.org>");
    expect(headerValue(raw, "X-Missing")).toBeNull();
    expect(normalizeMessageId(" <a@example.org> ")).toBe("a@example.org");
  });

  it("does not read header fields from the body", () => {
    expect(headerValue(bytes("Subject: x\r\n\r\nMessage-ID: <b@example.org>\r\n"), "message-id")).toBeNull();
  });
});

describe("parseStructuredHeader", () => {
  it("reads RFC 2231 continuations and charsets", () => {
    const { token, params } = parseStructuredHeader(
      "Attachment; filename*0*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82; filename*1=\".pdf\"; size=10",
    );
    expect(token).toBe("attachment");
    expect(params.get("filename")).toBe("отчёт.pdf");
    expect(params.get("size")).toBe("10");
  });

  it("reads quoted values with semicolons and RFC 2047 names", () => {
    const { params } = parseStructuredHeader(
      'application/octet-stream; name="a; b.txt"; x="=?UTF-8?Q?caf=C3=A9?="',
    );
    expect(params.get("name")).toBe("a; b.txt");
    expect(params.get("x")).toBe("café");
  });
});

describe("describeStructure", () => {
  it("lists the MIME tree with types, dispositions, names and sizes", () => {
    expect(describeStructure(bytes(MULTIPART))).toEqual([
      `multipart/mixed · ${formatSize(bytes(MULTIPART.split("\r\n\r\n").slice(1).join("\r\n\r\n")).length)}`,
      expect.stringMatching(/^ {2}multipart\/alternative · \d+ B$/),
      "    text/plain · 19 B",
      "    text/html · 26 B",
      '  application/pdf · attachment · "report.pdf" · 12 B',
    ]);
  });

  it("describes a single-part message without a content type as text/plain", () => {
    expect(describeStructure(bytes("Subject: x\r\n\r\nhello"))).toEqual(["text/plain · 5 B"]);
  });

  it("keeps hostile filenames on one line of plain text", () => {
    const raw = bytes(
      [
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        'Content-Disposition: attachment; filename="evil‮txt.exe\r\n injected.html"',
        "",
        "x",
        "--b--",
      ].join("\r\n"),
    );
    const lines = describeStructure(raw);
    expect(lines[1]).toBe('  text/plain · attachment · "eviltxt.exe injected.html" · 1 B');
  });

  it("stops at the line cap", () => {
    const parts = Array.from({ length: STRUCTURE_MAX_LINES + 5 }, () => "--b\r\n\r\nx").join("\r\n");
    const raw = bytes(`Content-Type: multipart/mixed; boundary=b\r\n\r\n${parts}\r\n--b--\r\n`);
    const lines = describeStructure(raw);
    expect(lines).toHaveLength(STRUCTURE_MAX_LINES + 1);
    expect(lines.at(-1)).toBe("…");
  });

  it("walks into an attached message", () => {
    const raw = bytes(
      [
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: message/rfc822",
        "",
        "Subject: inner",
        "",
        "hi",
        "--b--",
      ].join("\r\n"),
    );
    expect(describeStructure(raw).slice(1)).toEqual(["  message/rfc822 · 20 B", "    text/plain · 2 B"]);
  });
});

/** Milliseconds `fn` takes. */
function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("adversarial input (fix round 1)", () => {
  it("normalizes a Message-ID with a long run of inner spaces quickly", () => {
    const hostile = `<a${" ".repeat(200_000)}b`;
    expect(timed(() => normalizeMessageId(hostile))).toBeLessThan(50);
    expect(normalizeMessageId("<  a@example.org  >")).toBe("a@example.org");
  });

  it("decodes two adjacent encoded words of about 300 KB each without a RangeError", () => {
    const word = `=?UTF-8?B?${btoa("a".repeat(225_000))}?=`;
    const raw = bytes(`Subject: ${word} ${word}\r\n\r\n`);
    const pairs = readHeaders(raw);
    expect(pairs[0]![0]).toBe("Subject");
    expect(pairs.at(-1)).toEqual(HEADERS_TRUNCATED);
  });

  it("reads a filename* of 200k escapes without a RangeError", () => {
    const { params } = parseStructuredHeader(`attachment; filename*=UTF-8''${"%41".repeat(200_000)}`);
    expect(params.get("filename")!.startsWith("AAAA")).toBe(true);
  });

  // 12 MB inputs: big enough that a whole-message rescan per part takes seconds,
  // small enough to keep CI fast once each scan is bounded to its part.
  const TAIL_BYTES = 12 * 1024 * 1024;

  /** `head`, then `unit` repeated until the message is about TAIL_BYTES long. */
  function repeated(head: string, unit: string): Uint8Array {
    const headBytes = bytes(head);
    const unitBytes = bytes(unit);
    const count = Math.ceil(TAIL_BYTES / unitBytes.length);
    const raw = new Uint8Array(headBytes.length + count * unitBytes.length);
    raw.set(headBytes);
    for (let i = 0; i < count; i++) raw.set(unitBytes, headBytes.length + i * unitBytes.length);
    return raw;
  }

  it("walks a body of bare boundary lines in time bounded by the parts shown", () => {
    const raw = repeated("Content-Type: multipart/mixed; boundary=a\n\n", "--a\n");
    let lines: string[] = [];
    const ms = timed(() => (lines = describeStructure(raw)));
    expect(lines).toHaveLength(STRUCTURE_MAX_LINES + 1);
    expect(lines.at(-1)).toBe("…");
    // Loose for the same reason as the folded-lines test below.
    expect(ms).toBeLessThan(3000);
  });

  it("does not rescan a long tail of folded lines for every part without a blank line", () => {
    const parts = "--a\nX-Part: y\n".repeat(190);
    const raw = repeated(
      `Content-Type: multipart/mixed; boundary=a\n\n${parts}--a\nX-Tail: y\n`,
      " folded\n",
    );
    let lines: string[] = [];
    const ms = timed(() => (lines = describeStructure(raw)));
    expect(lines).toHaveLength(192);
    // A rescan per part is orders of magnitude slower; the loose bound only
    // keeps a loaded machine (parallel suite) from failing a linear run.
    expect(ms).toBeLessThan(3000);
  });

  it("caps the number of header pairs", () => {
    const raw = bytes(`${"X: y\r\n".repeat(3000)}\r\n`);
    const pairs = readHeaders(raw);
    expect(pairs).toHaveLength(HEADERS_MAX_PAIRS + 1);
    expect(pairs.at(-1)).toEqual(HEADERS_TRUNCATED);
  });
});
