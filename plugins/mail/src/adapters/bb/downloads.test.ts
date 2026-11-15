import { describe, expect, it } from "vitest";
import { FixedClock } from "../../core/testing/fakes.ts";
import {
  TICKET_TTL_MS,
  TicketBook,
  contentDisposition,
  downloadHeaders,
  emlFileName,
  safeContentType,
  sanitizeFileName,
} from "./downloads.ts";

const T0 = new Date("2026-11-15T10:00:00.000Z");

describe("TicketBook", () => {
  it("mints 32 random bytes as base64url and resolves a ticket once", () => {
    const clock = new FixedClock(T0);
    const book = new TicketBook<{ id: string }>(clock);
    const ticket = book.mint({ id: "m1" });

    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(book.mint({ id: "m1" })).not.toBe(ticket);
    expect(book.take(ticket)).toEqual({ id: "m1" });
    expect(book.take(ticket)).toBeNull();
  });

  it("expires a ticket after 60 seconds", () => {
    const clock = new FixedClock(T0);
    const book = new TicketBook<string>(clock);
    const early = book.mint("a");
    const late = book.mint("b");

    clock.set(new Date(T0.getTime() + TICKET_TTL_MS - 1));
    expect(book.take(early)).toBe("a");
    clock.set(new Date(T0.getTime() + TICKET_TTL_MS));
    expect(book.take(late)).toBeNull();
  });

  it("refuses unknown and malformed tickets", () => {
    const book = new TicketBook<string>(new FixedClock(T0));
    book.mint("a");
    expect(book.take("")).toBeNull();
    expect(book.take("x".repeat(43))).toBeNull();
    expect(book.take("../../etc")).toBeNull();
  });

  it("prunes expired tickets and keeps the map bounded", () => {
    const clock = new FixedClock(T0);
    const book = new TicketBook<number>(clock, 3);
    book.mint(1);
    clock.set(new Date(T0.getTime() + TICKET_TTL_MS));
    const live = [book.mint(2), book.mint(3), book.mint(4), book.mint(5)];
    expect(book.size).toBe(3);
    // The oldest live ticket made room for the newest.
    expect(book.take(live[0]!)).toBeNull();
    expect(book.take(live[3]!)).toBe(5);
  });
});

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

describe("emlFileName", () => {
  it("is YYYY-MM-DD subject.eml", () => {
    expect(emlFileName("2026-11-13T08:30:00.000Z", "Invented quarterly note")).toBe(
      "2026-11-13 Invented quarterly note.eml",
    );
  });

  it("keeps slashes of the subject out of the path and falls back", () => {
    expect(emlFileName("2026-11-13T08:30:00.000Z", "Q3/Q4 ../plan")).toBe("2026-11-13 Q3-Q4 ..-plan.eml");
    expect(emlFileName(null, "")).toBe("message.eml");
    expect(emlFileName("not a date", "Hello")).toBe("Hello.eml");
  });

  it("caps a long subject and keeps .eml", () => {
    const name = emlFileName("2026-11-13T08:30:00.000Z", "s".repeat(300));
    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith(".eml")).toBe(true);
  });
});

describe("contentDisposition", () => {
  it("gives an RFC 5987 name and an ASCII fallback without quotes or backslashes", () => {
    expect(contentDisposition('a "b"\\c.txt')).toBe(
      `attachment; filename="a bc.txt"; filename*=UTF-8''a%20%22b%22%5Cc.txt`,
    );
    expect(contentDisposition("отчёт (1).pdf")).toBe(
      `attachment; filename="_____ (1).pdf"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%281%29.pdf`,
    );
    expect(contentDisposition("it's*.txt")).toContain("filename*=UTF-8''it%27s%2A.txt");
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

describe("downloadHeaders", () => {
  it("sets exactly the download headers", () => {
    expect(downloadHeaders("a.pdf", "application/pdf", 12)).toEqual({
      "Content-Type": "application/pdf",
      "Content-Length": "12",
      "Content-Disposition": `attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
    });
  });
});

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("fix round 1", () => {
  it("sanitizes long runs of dots and spaces quickly", () => {
    for (const hostile of [
      `a${".".repeat(200_000)}b`,
      `a${" .".repeat(100_000)}b`,
      `${".".repeat(200_000)}`,
      `a${"\t".repeat(200_000)}b`,
    ]) {
      expect(timed(() => sanitizeFileName(hostile, "attachment"))).toBeLessThan(50);
      expect(timed(() => emlFileName("2026-11-13T08:30:00.000Z", hostile))).toBeLessThan(50);
    }
    expect(sanitizeFileName("report. . .", "attachment")).toBe("report");
  });

  it("strips Windows-reserved characters", () => {
    expect(sanitizeFileName('a:b*c?d<e>f|g"h.txt', "attachment")).toBe("abcdefgh.txt");
    expect(emlFileName("2026-11-13T08:30:00.000Z", "Re: plan?")).toBe("2026-11-13 Re plan.eml");
    expect(sanitizeFileName('"?*', "attachment")).toBe("attachment");
  });

  it("falls back when the ASCII form of the name is empty or only dots", () => {
    expect(contentDisposition('""', "attachment")).toBe(
      `attachment; filename="attachment"; filename*=UTF-8''%22%22`,
    );
    expect(contentDisposition("..", "message")).toBe(`attachment; filename="message"; filename*=UTF-8''..`);
  });

  it("passes through only an allow-list of inert types", () => {
    for (const type of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
      "audio/mpeg",
      "video/mp4",
      "application/zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]) {
      expect(safeContentType(type), type).toBe(type);
    }
    for (const type of [
      "application/x-msdownload",
      "application/x-sh",
      "application/java-archive",
      "application/json",
      "text/markdown",
      "image/x-icon",
      "video/x-unknown+xml",
      "application/octet-stream",
    ]) {
      expect(safeContentType(type), type).toBe("application/octet-stream");
    }
  });
});
