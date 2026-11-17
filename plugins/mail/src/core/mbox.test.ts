import { describe, expect, it } from "vitest";
import { mboxBody, mboxEntry, mboxFromLine, mboxSeparator } from "./mbox.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const FALLBACK = new Date("2026-11-17T10:00:00.000Z");

describe("mboxBody", () => {
  it("turns CRLF into LF, quotes lines that look like a separator, and ends with an empty line", () => {
    const raw = bytes("Subject: Invented\r\n\r\nHello\r\nFrom the garden\r\n>From before\r\n>>From twice\r\nfrom lower case\r\nNot From here\r\n");
    expect(text(mboxBody(raw))).toBe(
      "Subject: Invented\n\nHello\n>From the garden\n>>From before\n>>>From twice\nfrom lower case\nNot From here\n\n",
    );
  });

  it("closes a message that does not end with a line end, and keeps a lone CR", () => {
    expect(text(mboxBody(bytes("A\r\n\r\nlast line")))).toBe("A\n\nlast line\n\n");
    expect(text(mboxBody(bytes("a\rb\r\n")))).toBe("a\rb\n\n");
    expect(text(mboxBody(bytes("From first line\r\n")))).toBe(">From first line\n\n");
    expect(text(mboxBody(new Uint8Array()))).toBe("\n");
  });

  it("keeps bytes that are not UTF-8 as they are", () => {
    const raw = new Uint8Array([0x41, 0xff, 0xfe, 0x0d, 0x0a, 0x80]);
    expect([...mboxBody(raw)]).toEqual([0x41, 0xff, 0xfe, 0x0a, 0x80, 0x0a, 0x0a]);
  });

  it("handles a large message of short lines in bounded time", () => {
    const raw = bytes("From x\r\n".repeat(400_000));
    const start = performance.now();
    const out = mboxBody(raw);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(out.length).toBe(400_000 * 8 + 1);
  });
});

describe("mboxFromLine / mboxSeparator", () => {
  it("writes the classic date, in UTC, with a padded day", () => {
    expect(mboxFromLine("ana@example.com", new Date("2026-11-07T09:05:03.000Z"))).toBe("From ana@example.com Sat Nov  7 09:05:03 2026");
    expect(mboxFromLine("ana@example.com", FALLBACK)).toBe("From ana@example.com Tue Nov 17 10:00:00 2026");
  });

  it("takes the sender and the date from the message, and falls back for either", () => {
    const raw = (from: string, date = "Date: Fri, 13 Nov 2026 08:30:00 +0100\r\n") => bytes(`From: ${from}\r\n${date}\r\nBody\r\n`);
    expect(mboxSeparator(raw("Ana Example <ana@example.com>"), FALLBACK)).toBe("From ana@example.com Fri Nov 13 07:30:00 2026");
    expect(mboxSeparator(raw("bare@example.org"), FALLBACK)).toBe("From bare@example.org Fri Nov 13 07:30:00 2026");
    expect(mboxSeparator(raw("Undisclosed sender"), FALLBACK)).toBe("From MAILER-DAEMON Fri Nov 13 07:30:00 2026");
    expect(mboxSeparator(raw("<ana@example.com>", "Date: someday\r\n"), FALLBACK)).toBe("From ana@example.com Tue Nov 17 10:00:00 2026");
    expect(mboxSeparator(bytes("Subject: nothing else\r\n\r\n"), FALLBACK)).toBe("From MAILER-DAEMON Tue Nov 17 10:00:00 2026");
    // An address that would break the line is not used.
    expect(mboxSeparator(raw("<a\u00e9@example.com>"), FALLBACK)).toMatch(/^From MAILER-DAEMON /);
  });

  it("an entry is the separator, then the body", () => {
    expect(text(mboxEntry(bytes("From: <ana@example.com>\r\nDate: Fri, 13 Nov 2026 07:30:00 +0000\r\n\r\nHi\r\n"), FALLBACK))).toBe(
      "From ana@example.com Fri Nov 13 07:30:00 2026\nFrom: <ana@example.com>\nDate: Fri, 13 Nov 2026 07:30:00 +0000\n\nHi\n\n",
    );
  });
});
