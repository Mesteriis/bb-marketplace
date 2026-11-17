import { describe, expect, it } from "vitest";
import { MboxSplitter, isMboxSeparator, mboxBody, mboxEntry, mboxFromLine, mboxSeparator, mboxSliceMessage, type MboxMessage } from "./mbox.ts";

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

describe("MboxSplitter", () => {
  const SEP = (who: string) => `From ${who} Fri Nov 13 08:30:00 2026\n`;
  const A = "Subject: Invented one\n\nFirst body\n>From the garden\n>>From deeper\n";
  const B = "Subject: Invented two\r\n\r\nSecond body\r\n";
  const FILE = `${SEP("a@example.com")}${A}\n${SEP("b@example.com")}${B}\n`;

  const split = (file: string, chunkSize: number, max = 1_000_000): MboxMessage[] => {
    const data = bytes(file);
    const splitter = new MboxSplitter(max);
    const out: MboxMessage[] = [];
    // One reused buffer, as a file reader would hand over.
    const buffer = new Uint8Array(chunkSize);
    for (let at = 0; at < data.length; at += chunkSize) {
      const n = Math.min(chunkSize, data.length - at);
      buffer.set(data.subarray(at, at + n));
      out.push(...splitter.push(buffer.subarray(0, n)));
    }
    out.push(...splitter.end());
    return out;
  };

  it("finds each message, unquotes it, and says where it sits in the file, whatever the chunk size", () => {
    const whole = split(FILE, FILE.length);
    expect(whole.map((m) => text(m.raw!))).toEqual(["Subject: Invented one\n\nFirst body\nFrom the garden\n>From deeper\n", B]);
    const first = SEP("a@example.com").length;
    expect(whole.map((m) => [m.offset, m.length])).toEqual([
      [first, A.length + 1],
      [first + A.length + 1 + SEP("b@example.com").length, B.length + 1],
    ]);
    for (const size of [1, 2, 3, 5, 7, 16, 64]) expect(split(FILE, size), `chunks of ${size}`).toEqual(whole);
    // The stored place gives the same message back.
    const data = bytes(FILE);
    for (const message of whole) {
      expect(mboxSliceMessage(data.subarray(message.offset, message.offset + message.length), 1_000_000)).toEqual(message.raw);
    }
  });

  it("round-trips what mboxEntry writes", () => {
    const originals = [
      bytes("From: <a@example.com>\r\nDate: Fri, 13 Nov 2026 07:30:00 +0000\r\n\r\nFrom here\r\n>From there\r\nlast"),
      bytes("From: <b@example.com>\r\n\r\n"),
    ];
    const file = originals.map((raw) => text(mboxEntry(raw, FALLBACK))).join("");
    const back = split(file, 9).map((m) => text(m.raw!));
    expect(back).toEqual(["From: <a@example.com>\nDate: Fri, 13 Nov 2026 07:30:00 +0000\n\nFrom here\n>From there\nlast\n", "From: <b@example.com>\n\n"]);
  });

  it("does not split on a body line that only begins with From, and ignores bytes before the first entry", () => {
    const body = "Subject: x\n\nFrom my point of view this is fine\nFrom a friend\n";
    const messages = split(`junk before\n${SEP("a@example.com")}${body}`, 11);
    expect(messages.map((m) => text(m.raw!))).toEqual([body]);
    expect(isMboxSeparator(bytes("From a@example.com Fri Nov 13 08:30:00 2026"))).toBe(true);
    expect(isMboxSeparator(bytes("From my point of view"))).toBe(false);
    expect(isMboxSeparator(bytes("From  two spaces 08:30"))).toBe(false);
    expect(isMboxSeparator(bytes(">From a@example.com Fri Nov 13 08:30:00 2026"))).toBe(false);
  });

  it("reports a message over the cap without its bytes and carries on", () => {
    const big = `Subject: big\n\n${"x".repeat(500)}\n`;
    const messages = split(`${SEP("a@example.com")}${big}\n${SEP("b@example.com")}${B}`, 37, 100);
    expect(messages.map((m) => m.raw === null)).toEqual([true, false]);
    expect(messages[0]!.length).toBe(big.length + 1);
    expect(text(messages[1]!.raw!)).toBe(B);
  });

  it("handles an empty file, a file without a final line end, and a lone separator at the end", () => {
    expect(split("", 8)).toEqual([]);
    expect(split("no mbox here\n", 8)).toEqual([]);
    expect(split(`${SEP("a@example.com")}Subject: x\n\nno line end`, 6).map((m) => text(m.raw!))).toEqual(["Subject: x\n\nno line end"]);
    const lone = split(`${SEP("a@example.com")}Subject: x\n\nbody\n\n${SEP("b@example.com").trimEnd()}`, 6);
    expect(lone.map((m) => text(m.raw!))).toEqual(["Subject: x\n\nbody\n"]);
  });

  it("splits a large file of many small messages in bounded time", () => {
    const one = `${SEP("a@example.com")}Subject: x\n\n${"line of text\n".repeat(20)}\n`;
    const file = bytes(one.repeat(20_000));
    const splitter = new MboxSplitter(1_000_000);
    let count = 0;
    const start = performance.now();
    for (let at = 0; at < file.length; at += 65_536) count += splitter.push(file.subarray(at, at + 65_536)).length;
    count += splitter.end().length;
    expect(count).toBe(20_000);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
