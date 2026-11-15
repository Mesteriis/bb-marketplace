import { describe, expect, it } from "vitest";
import { bccHeaderLine, insertBccHeader } from "./compose-bcc.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("bccHeaderLine", () => {
  it("is null without Bcc recipients", () => {
    expect(bccHeaderLine([])).toBeNull();
  });

  it("writes one CRLF-terminated line, quoting ASCII names", () => {
    expect(
      bccHeaderLine([
        { name: "Bob B", address: "bob@example.com" },
        { name: null, address: "c@example.com" },
        { name: 'D "D"', address: "d@example.com" },
      ]),
    ).toBe('Bcc: "Bob B" <bob@example.com>, c@example.com, "D \\"D\\"" <d@example.com>\r\n');
  });

  it("stays ASCII: a non-ASCII name is left out, the address kept", () => {
    const line = bccHeaderLine([{ name: "Анна", address: "anna@xn--80a1acny.example" }]);
    expect(line).toBe("Bcc: anna@xn--80a1acny.example\r\n");
    expect(/^[\u0000-\u007f]*$/.test(line ?? "")).toBe(true);
  });

  it("folds long lists at 76 columns", () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ name: null, address: `person${i}@example.com` }));
    const line = bccHeaderLine(list) ?? "";
    expect(line.endsWith("\r\n")).toBe(true);
    const physical = line.slice(0, -2).split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    for (const [index, part] of physical.entries()) {
      expect(part.length).toBeLessThanOrEqual(76);
      if (index > 0) expect(part.startsWith(" ")).toBe(true);
    }
    expect(physical.join("").replace(/^Bcc: /, "").split(/,\s*/)).toEqual(list.map((a) => a.address));
  });

  it("refuses an address that is not plain ASCII without line breaks", () => {
    expect(() => bccHeaderLine([{ name: null, address: "bob@example.com\r\nX: y" }])).toThrow();
    expect(() => bccHeaderLine([{ name: null, address: "бob@example.com" }])).toThrow();
    expect(bccHeaderLine([{ name: "Bob\r\nX: y", address: "bob@example.com" }])).toBe(
      "Bcc: bob@example.com\r\n",
    );
  });
});

describe("insertBccHeader", () => {
  const raw = encode(
    "From: owner@example.org\r\nTo: anna@example.org\r\nSubject: Garden\r\n\r\nBody line\r\n\r\nSecond\r\n",
  );

  it("inserts the line at the end of the header block and leaves every other byte equal", () => {
    const line = "Bcc: bob@example.com\r\n";
    const out = insertBccHeader(raw, line);
    expect(decode(out)).toBe(
      "From: owner@example.org\r\nTo: anna@example.org\r\nSubject: Garden\r\nBcc: bob@example.com\r\n\r\nBody line\r\n\r\nSecond\r\n",
    );
    const at = decode(raw).indexOf("\r\n\r\n") + 2;
    const lineBytes = encode(line);
    expect(out.length).toBe(raw.length + lineBytes.length);
    expect([...out.slice(0, at)]).toEqual([...raw.slice(0, at)]);
    expect([...out.slice(at, at + lineBytes.length)]).toEqual([...lineBytes]);
    expect([...out.slice(at + lineBytes.length)]).toEqual([...raw.slice(at)]);
  });

  it("keeps a folded line intact", () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ name: null, address: `person${i}@example.com` }));
    const line = bccHeaderLine(list) ?? "";
    expect(decode(insertBccHeader(raw, line))).toContain(`Subject: Garden\r\n${line}\r\nBody line`);
  });

  it("does not touch non-UTF-8 body bytes", () => {
    const binary = new Uint8Array([...encode("Subject: x\r\n\r\n"), 0xff, 0x00, 0xfe, 0x0d, 0x0a]);
    const out = insertBccHeader(binary, "Bcc: bob@example.com\r\n");
    expect([...out.slice(-5)]).toEqual([0xff, 0x00, 0xfe, 0x0d, 0x0a]);
  });

  it("refuses a message without a header block end, or a line that is not one Bcc header", () => {
    expect(() => insertBccHeader(encode("Subject: x\r\n"), "Bcc: bob@example.com\r\n")).toThrow();
    expect(() => insertBccHeader(raw, "Bcc: bob@example.com")).toThrow();
    expect(() => insertBccHeader(raw, "X-Other: 1\r\n")).toThrow();
    expect(() => insertBccHeader(raw, "Bcc: a@example.com\r\nX-Injected: 1\r\n")).toThrow();
    expect(() => insertBccHeader(raw, "Bcc: a@example.com\r\n\r\n")).toThrow();
    expect(() => insertBccHeader(raw, "Bcc: Анна <a@example.com>\r\n")).toThrow();
  });
});
