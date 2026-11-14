import PostalMime from "postal-mime";
import type { FetchMessageObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { ImapAuthError } from "../../core/index.ts";
import { describeImapError, toFetchedMessage, toImapflowOptions } from "./imapflow-gateway.ts";

const RAW = [
  "From: Invented Sender <sender@example.org>",
  "To: Owner <owner@example.org>",
  "Subject: Invented subject",
  "Message-ID: <raw-1@example.org>",
  "Date: Tue, 10 Nov 2026 09:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/alternative; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Invented plain body.",
  "--inner",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Invented <b>html</b> body.</p>",
  "--inner--",
  "--outer",
  'Content-Type: application/pdf; name="plan.pdf"',
  'Content-Disposition: attachment; filename="plan.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "SW52ZW50ZWQgYXR0YWNobWVudA==",
  "--outer",
  "Content-Type: image/png",
  "Content-Disposition: inline",
  "Content-ID: <logo@example.org>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--outer--",
  "",
].join("\r\n");

function imapMessage(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  return {
    seq: 1,
    uid: 42,
    flags: new Set(["\\Seen", "\\Flagged"]),
    size: 2048,
    internalDate: new Date("2026-11-10T09:00:05.000Z"),
    envelope: {
      date: new Date("2026-11-10T09:00:00.000Z"),
      subject: "Invented subject",
      messageId: "<raw-1@example.org>",
      inReplyTo: "<parent@example.org>",
      from: [{ name: "Invented Sender", address: "sender@example.org" }],
      to: [{ name: "", address: "owner@example.org" }],
      cc: [{ name: "Copy", address: "copy@example.org" }],
    },
    threadId: "1789000000000000001",
    source: Buffer.from(RAW),
    ...overrides,
  };
}

describe("toFetchedMessage", () => {
  it("maps envelope, flags and Gmail thread id", async () => {
    const parsed = await PostalMime.parse(RAW);
    const message = toFetchedMessage(imapMessage(), parsed);
    expect(message).toMatchObject({
      uid: 42,
      messageId: "<raw-1@example.org>",
      inReplyTo: "<parent@example.org>",
      gmThreadId: "1789000000000000001",
      date: "2026-11-10T09:00:00.000Z",
      from: { name: "Invented Sender", address: "sender@example.org" },
      to: [{ name: null, address: "owner@example.org" }],
      cc: [{ name: "Copy", address: "copy@example.org" }],
      subject: "Invented subject",
      seen: true,
      flagged: true,
      size: 2048,
    });
    const unflagged = toFetchedMessage(imapMessage({ flags: new Set(), threadId: undefined }), parsed);
    expect(unflagged).toMatchObject({ seen: false, flagged: false, gmThreadId: null });
  });

  it("takes text and html from postal-mime", async () => {
    const message = toFetchedMessage(imapMessage(), await PostalMime.parse(RAW));
    expect(message.bodyText?.trim()).toBe("Invented plain body.");
    expect(message.bodyHtml).toContain("<p>Invented <b>html</b> body.</p>");
  });

  it("lists attachments without content", async () => {
    const message = toFetchedMessage(imapMessage(), await PostalMime.parse(RAW));
    expect(message.attachments).toEqual([
      { partId: "1", filename: "plan.pdf", mimeType: "application/pdf", size: 19, isInline: false },
      { partId: "2", filename: null, mimeType: "image/png", size: 8, isInline: true },
    ]);
    expect(JSON.stringify(message.attachments)).not.toContain("content");
  });

  it("splits references from the parsed headers", async () => {
    const raw = "References: <a@example.org> <b@example.org>\r\n\t<c@example.org><d@example.org>\r\nSubject: x\r\n\r\nbody";
    const message = toFetchedMessage(imapMessage(), await PostalMime.parse(raw));
    expect(message.references).toEqual([
      "<a@example.org>",
      "<b@example.org>",
      "<c@example.org>",
      "<d@example.org>",
    ]);
  });

  it("handles a message without Message-ID or date", async () => {
    const raw = "From: sender@example.org\r\nSubject: Undated\r\n\r\nInvented body.";
    const parsed = await PostalMime.parse(raw);
    const base = imapMessage({
      envelope: { subject: "Undated", from: [{ address: "sender@example.org" }] },
      threadId: undefined,
      size: undefined,
    });
    const message = toFetchedMessage(base, parsed);
    expect(message).toMatchObject({
      messageId: null,
      inReplyTo: null,
      references: [],
      date: "2026-11-10T09:00:05.000Z",
      from: { name: null, address: "sender@example.org" },
      to: [],
      cc: [],
      size: Buffer.byteLength(RAW),
      attachments: [],
    });
    const noDates = toFetchedMessage({ ...base, internalDate: undefined }, parsed);
    expect(noDates.date).toBeNull();
    const badDate = toFetchedMessage(
      { ...base, envelope: { ...base.envelope, date: "not a date" }, internalDate: undefined },
      parsed,
    );
    expect(badDate.date).toBeNull();
  });

  it("falls back to postal-mime headers when the envelope is missing", async () => {
    const message = toFetchedMessage(
      imapMessage({ envelope: undefined }),
      await PostalMime.parse(RAW),
    );
    expect(message).toMatchObject({
      messageId: "<raw-1@example.org>",
      subject: "Invented subject",
      from: { name: "Invented Sender", address: "sender@example.org" },
      to: [{ name: "Owner", address: "owner@example.org" }],
    });
  });
});

describe("toImapflowOptions", () => {
  it("always connects with TLS and never logs", () => {
    for (const port of [993, 143, 1143]) {
      const options = toImapflowOptions({
        host: "imap.example.org",
        port,
        user: "owner@example.org",
        password: "invented-password",
      });
      expect(options).toMatchObject({
        host: "imap.example.org",
        port,
        secure: true,
        logger: false,
        auth: { user: "owner@example.org", pass: "invented-password" },
      });
      expect(options.doSTARTTLS).not.toBe(false);
    }
  });
});

describe("describeImapError", () => {
  const password = "invented-password";

  it("maps authentication failures to ImapAuthError", () => {
    const failure = Object.assign(new Error(`NO [AUTHENTICATIONFAILED] bad ${password}`), {
      authenticationFailed: true,
    });
    expect(describeImapError(failure)).toBeInstanceOf(ImapAuthError);
    const coded = Object.assign(new Error(`LOGIN ${password}`), {
      serverResponseCode: "AUTHENTICATIONFAILED",
    });
    expect(describeImapError(coded)).toBeInstanceOf(ImapAuthError);
  });

  it("builds messages from codes, never from the error text", () => {
    const withCode = Object.assign(new Error(`server said ${password}`), {
      code: "ETIMEOUT",
      response: `A1 NO ${password}`,
    });
    const mapped = describeImapError(withCode);
    expect(mapped.message).toBe("IMAP error (ETIMEOUT)");
    expect((mapped as { code?: string }).code).toBe("ETIMEOUT");
    const plain = describeImapError(new Error(`LOGIN owner ${password}`));
    expect(plain.message).toBe("IMAP error");
    for (const error of [mapped, plain]) {
      expect(error.message).not.toContain(password);
      expect(JSON.stringify({ ...error })).not.toContain(password);
      expect(String(error.stack)).not.toContain(password);
    }
    const tls = Object.assign(new Error(password), { tlsFailed: true });
    expect(describeImapError(tls).message).toBe("IMAP error (TLS failed)");
    const weird = Object.assign(new Error("x"), { code: `bad code ${password}` });
    expect(describeImapError(weird).message).toBe("IMAP error");
  });
});
