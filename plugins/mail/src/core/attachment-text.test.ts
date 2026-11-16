import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_TEXT_CAPS,
  ATTACHMENT_TEXT_TOTAL_MAX,
  decodeText,
  excerptAround,
  indexCandidates,
  type AttachmentCandidate,
} from "./attachment-text.ts";

const MB = 1024 * 1024;

describe("decodeText", () => {
  it("decodes UTF-8 by default and with an unknown charset", () => {
    const bytes = new TextEncoder().encode("Invented caf\u00e9 notes");
    expect(decodeText(bytes, null)).toBe("Invented caf\u00e9 notes");
    expect(decodeText(bytes, "x-unknown-charset")).toBe("Invented caf\u00e9 notes");
  });

  it("decodes latin1", () => {
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "iso-8859-1")).toBe("caf\u00e9");
  });

  it("replaces broken UTF-8", () => {
    expect(decodeText(new Uint8Array([0x61, 0xc3, 0x28, 0x62]), "utf-8")).toBe("a\ufffd(b");
  });

  it("removes NUL and control characters and collapses whitespace", () => {
    const bytes = new TextEncoder().encode("a\u0000b\u0007 \t\n\n c\u0085d  ");
    expect(decodeText(bytes, "utf-8")).toBe("ab c d");
  });

  it("caps the text at 200 000 characters", () => {
    const bytes = new TextEncoder().encode("x".repeat(250_000));
    expect(decodeText(bytes, "utf-8")).toHaveLength(ATTACHMENT_TEXT_CAPS.chars);
    expect(ATTACHMENT_TEXT_CAPS.chars).toBe(200_000);
  });
});

describe("caps", () => {
  it("are the spec's, with the lower PDF file cap", () => {
    expect(ATTACHMENT_TEXT_CAPS).toEqual({
      perRound: 50,
      rawPerDay: 200 * MB,
      file: 10 * MB,
      pdfFile: 5 * MB,
      message: 25 * MB,
      chars: 200_000,
    });
    expect(ATTACHMENT_TEXT_TOTAL_MAX).toBe(50_000_000);
  });
});

function candidate(extra: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
  return {
    messageId: "m1",
    partId: "2",
    kind: "text",
    size: 1000,
    messageSize: 5000,
    date: "2026-11-10T00:00:00.000Z",
    folderUse: "inbox",
    kept: null,
    inline: false,
    ...extra,
  };
}

describe("indexCandidates", () => {
  it("keeps text and PDF attachments within the caps, newest first", () => {
    const picked = indexCandidates(
      [
        candidate({ messageId: "old", date: "2026-01-01T00:00:00.000Z" }),
        candidate({ messageId: "new", date: "2026-11-15T00:00:00.000Z", kind: "pdf" }),
        candidate({ messageId: "nodate", date: null }),
        candidate({ messageId: "img", kind: "image" }),
        candidate({ messageId: "inline", inline: true }),
        candidate({ messageId: "spam", folderUse: "junk" }),
        candidate({ messageId: "trash", folderUse: "trash" }),
        candidate({ messageId: "hit", kept: "search" }),
        candidate({ messageId: "history", kept: "history" }),
        candidate({ messageId: "bigtext", size: 10 * MB + 1 }),
        candidate({ messageId: "bigpdf", kind: "pdf", size: 5 * MB + 1 }),
        candidate({ messageId: "okpdf", kind: "pdf", size: 5 * MB }),
        candidate({ messageId: "bigmsg", messageSize: 25 * MB + 1 }),
      ],
      0,
    );
    expect(picked.candidates.map((c) => c.messageId)).toEqual(["new", "history", "okpdf", "old", "nodate"]);
  });

  it("counts a message's raw size once and stops at the daily budget", () => {
    const picked = indexCandidates(
      [
        candidate({ messageId: "a", partId: "2", messageSize: 20 * MB }),
        candidate({ messageId: "a", partId: "3", messageSize: 20 * MB }),
        candidate({ messageId: "b", messageSize: 20 * MB, date: "2026-11-09T00:00:00.000Z" }),
      ],
      170 * MB,
    );
    expect(picked.candidates.map((c) => `${c.messageId}/${c.partId}`)).toEqual(["a/2", "a/3"]);
    expect(picked.rawBytes).toBe(20 * MB);
  });

  it("takes at most 50 per round", () => {
    const many = Array.from({ length: 80 }, (_, i) => candidate({ messageId: `m${i}` }));
    expect(indexCandidates(many, 0).candidates).toHaveLength(ATTACHMENT_TEXT_CAPS.perRound);
  });
});

describe("excerptAround", () => {
  const body = `${"a ".repeat(100)}Invoice INV-2041 total ${"b ".repeat(100)}`;

  it("centers 120 characters on the phrase, case-insensitively", () => {
    const excerpt = excerptAround(body, "inv-2041", 120);
    expect(excerpt.startsWith("\u2026")).toBe(true);
    expect(excerpt.endsWith("\u2026")).toBe(true);
    expect(excerpt).toContain("INV-2041");
    expect(excerpt.replace(/\u2026/g, "")).toHaveLength(120);
  });

  it("starts at the beginning when the phrase is missing or near the start", () => {
    expect(excerptAround("short invented text", "zzz", 120)).toBe("short invented text");
    expect(excerptAround("Invoice first, then more", "invoice", 10)).toBe("Invoice fi\u2026");
  });
});
