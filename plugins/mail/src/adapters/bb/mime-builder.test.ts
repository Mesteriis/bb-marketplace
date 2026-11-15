import { describe, expect, it } from "vitest";
import { bccHeaderLine, insertBccHeader, type OutgoingMessage } from "../../core/index.ts";
import { parseMail } from "./imapflow-gateway.ts";
import { HeaderValueError, composerOptions, createMimeBuilder } from "./mime-builder.ts";

const PDF = new TextEncoder().encode("%PDF-invented attachment bytes");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { name: "Invented Owner", address: "owner@example.org" },
    to: [{ name: "Ana Example", address: "ana@example.com" }],
    cc: [{ name: null, address: "cc@example.com" }],
    bcc: [{ name: "Hidden", address: "hidden@example.net" }],
    subject: "Re: Invented plan — ünïcode",
    messageId: "<draft-1@example.org>",
    date: "2026-11-15T10:00:00.000Z",
    inReplyTo: "<parent@example.com>",
    references: ["<root@example.com>", "<parent@example.com>"],
    html: "<p>Invented <b>body</b></p>",
    text: "Invented body",
    attachments: [
      { fileName: "plan.pdf", mimeType: "application/pdf", bytes: PDF, contentId: null },
      { fileName: "logo.png", mimeType: "image/png", bytes: PNG, contentId: "<logo@example.com>" },
    ],
    ...overrides,
  };
}

const text = (raw: Uint8Array) => new TextDecoder().decode(raw);
const headerBlock = (raw: Uint8Array) => text(raw).split("\r\n\r\n")[0]!;

describe("createMimeBuilder", () => {
  it("round-trips through postal-mime with the expected headers and parts", async () => {
    const raw = await createMimeBuilder().build(message());
    const parsed = await parseMail(raw);
    expect(parsed.messageId).toBe("<draft-1@example.org>");
    expect(parsed.from).toMatchObject({ name: "Invented Owner", address: "owner@example.org" });
    expect(parsed.to).toEqual([{ name: "Ana Example", address: "ana@example.com" }]);
    expect(parsed.cc).toEqual([{ name: "", address: "cc@example.com" }]);
    expect(parsed.subject).toBe("Re: Invented plan — ünïcode");
    expect(parsed.inReplyTo).toBe("<parent@example.com>");
    expect(parsed.references).toBe("<root@example.com> <parent@example.com>");
    expect(new Date(parsed.date!).toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(parsed.text?.trim()).toBe("Invented body");
    expect(parsed.html).toContain("<b>body</b>");
    expect(parsed.attachments).toHaveLength(2);
    const pdf = parsed.attachments.find((a) => a.filename === "plan.pdf")!;
    expect(new Uint8Array(pdf.content as ArrayBuffer)).toEqual(PDF);
    const logo = parsed.attachments.find((a) => a.mimeType === "image/png")!;
    expect(logo.contentId).toBe("<logo@example.com>");
    expect(new Uint8Array(logo.content as ArrayBuffer)).toEqual(PNG);
  });

  it("writes no Bcc and no X-Mailer, with CRLF line breaks", async () => {
    const raw = await createMimeBuilder().build(message());
    const all = text(raw);
    expect(all).not.toMatch(/^bcc:/im);
    expect(all).not.toContain("hidden@example.net");
    expect(all).not.toMatch(/^x-mailer:/im);
    expect(all.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(headerBlock(raw)).toMatch(/^MIME-Version: 1\.0$/m);
    expect(headerBlock(raw)).toMatch(/^Content-Type: multipart\/mixed;/m);
    expect(all).toMatch(/Content-Type: multipart\/alternative;/);
  });

  it("a message without attachments is multipart/alternative", async () => {
    const raw = await createMimeBuilder().build(message({ attachments: [], cc: [], inReplyTo: null, references: [] }));
    expect(headerBlock(raw)).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(headerBlock(raw)).not.toMatch(/^(Cc|In-Reply-To|References):/im);
  });

  it("accepts an empty To (a Drafts copy)", async () => {
    const parsed = await parseMail(await createMimeBuilder().build(message({ to: [], cc: [] })));
    expect(parsed.to ?? []).toEqual([]);
    expect(parsed.subject).toBe("Re: Invented plan — ünïcode");
  });

  it("insertBccHeader(build(x)) differs from build(x) by exactly the Bcc line", async () => {
    const input = message();
    const raw = await createMimeBuilder().build(input);
    const line = bccHeaderLine(input.bcc)!;
    const copy = insertBccHeader(raw, line);
    const lineBytes = new TextEncoder().encode(line);
    expect(copy.length).toBe(raw.length + lineBytes.length);
    const at = headerBlock(raw).length + 2;
    expect(copy.slice(0, at)).toEqual(raw.slice(0, at));
    expect(copy.slice(at, at + lineBytes.length)).toEqual(lineBytes);
    expect(copy.slice(at + lineBytes.length)).toEqual(raw.slice(at));
    expect((await parseMail(copy)).bcc).toEqual([{ name: "Hidden", address: "hidden@example.net" }]);
  });

  it.each([
    ["subject", { subject: "Hi\r\nBcc: evil@example.com" }],
    ["subject NUL", { subject: "Hi\u0000there" }],
    ["display name", { to: [{ name: "Ana\nBcc: evil@example.com", address: "ana@example.com" }] }],
    ["address", { cc: [{ name: null, address: "cc@example.com\r\nX: y" }] }],
    ["in-reply-to", { inReplyTo: "<a@example.com>\r\nX: y" }],
    ["references", { references: ["<a@example.com>\nX: y"] }],
    ["message-id", { messageId: "<a@example.com>\r\n" }],
    [
      "file name",
      { attachments: [{ fileName: "a\r\n.pdf", mimeType: "application/pdf", bytes: PDF, contentId: null }] },
    ],
    [
      "mime type",
      { attachments: [{ fileName: "a.pdf", mimeType: "application/pdf\r\nX: y", bytes: PDF, contentId: null }] },
    ],
  ])("refuses CR/LF/NUL in the %s", async (_label, overrides) => {
    await expect(createMimeBuilder().build(message(overrides as Partial<OutgoingMessage>))).rejects.toBeInstanceOf(
      HeaderValueError,
    );
  });

  it("gives attachments by content only, with file and URL access off", () => {
    const options = composerOptions(
      message({
        attachments: [
          { fileName: "/etc/passwd", mimeType: "text/plain", bytes: PDF, contentId: null },
          { fileName: "https://example.com/x", mimeType: "text/plain", bytes: PDF, contentId: null },
        ],
      }),
    );
    expect(options.disableFileAccess).toBe(true);
    expect(options.disableUrlAccess).toBe(true);
    expect(options.bcc).toBeUndefined();
    expect(options.xMailer).toBeUndefined();
    for (const attachment of options.attachments ?? []) {
      expect(attachment).not.toHaveProperty("path");
      expect(attachment).not.toHaveProperty("href");
      expect(Buffer.isBuffer(attachment.content)).toBe(true);
    }
    expect(typeof options.html).toBe("string");
    expect(typeof options.text).toBe("string");
  });

  it("a file-path-like name stays a name: the bytes are the given ones", async () => {
    const raw = await createMimeBuilder().build(
      message({ attachments: [{ fileName: "/etc/passwd", mimeType: "text/plain", bytes: PDF, contentId: null }] }),
    );
    const parsed = await parseMail(raw);
    expect(new Uint8Array(parsed.attachments[0]!.content as ArrayBuffer)).toEqual(PDF);
  });
});
