// Moved from src/adapters/bb/downloads.test.ts with the functions (slice 3g).
import { describe, expect, it } from "vitest";
import { safeContentType, sanitizeFileName } from "./file-names.ts";

describe("sanitizeFileName", () => {
  it("keeps an ordinary name", () => {
    expect(sanitizeFileName("Invented report.pdf", "attachment")).toBe("Invented report.pdf");
    expect(sanitizeFileName("отчёт.pdf", "attachment")).toBe("отчёт.pdf");
  });

  it("drops directories and leading dots", () => {
    expect(sanitizeFileName("../../x", "attachment")).toBe("x");
    expect(sanitizeFileName("..\\..\\windows\\evil.bat", "attachment")).toBe("evil.bat");
    expect(sanitizeFileName(".hidden", "attachment")).toBe("hidden");
    expect(sanitizeFileName("../", "attachment")).toBe("attachment");
  });

  it("removes control and bidi characters and collapses whitespace", () => {
    expect(sanitizeFileName("a\r\nContent-Type: text.txt", "attachment")).toBe("a Content-Type text.txt");
    expect(sanitizeFileName("invoice‮fdp.exe", "attachment")).toBe("invoicefdp.exe");
    expect(sanitizeFileName("  a \t  b  .txt  ", "attachment")).toBe("a b .txt");
    expect(sanitizeFileName("\u0000\u0007", "attachment")).toBe("attachment");
  });

  it("falls back when there is no name", () => {
    expect(sanitizeFileName(null, "attachment")).toBe("attachment");
    expect(sanitizeFileName("   ", "message")).toBe("message");
  });

  it("trims to 120 characters keeping the extension", () => {
    const name = sanitizeFileName(`${"n".repeat(300)}.pdf`, "attachment");
    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith("n.pdf")).toBe(true);
    const emoji = sanitizeFileName(`${"😀".repeat(200)}.txt`, "attachment");
    expect(Array.from(emoji)).toHaveLength(120);
    expect(emoji.endsWith(".txt")).toBe(true);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("safeContentType", () => {
  it("keeps ordinary types and serves active content as octet-stream", () => {
    expect(safeContentType("application/pdf")).toBe("application/pdf");
    expect(safeContentType("IMAGE/PNG")).toBe("image/png");
    for (const type of [
      "text/html",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/xml",
      "application/xml",
      "text/javascript",
      "application/x-javascript",
      "application/ecmascript",
      "text/css",
      "multipart/related",
      "message/rfc822",
      "not a type",
      "text/plain\r\nX-Injected: 1",
    ]) {
      expect(safeContentType(type), type).toBe("application/octet-stream");
    }
  });
});
