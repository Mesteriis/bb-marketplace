import PostalMime from "postal-mime";
import type { FetchMessageObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { ImapAuthError } from "../../core/index.ts";
import {
  SafeImapError,
  createSession,
  describeImapError,
  toFetchedMessage,
  toImapflowOptions,
  type SessionClient,
} from "./imapflow-gateway.ts";

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
  it("always connects with TLS, never logs and bounds every wait", () => {
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
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
      });
      expect(options.doSTARTTLS).toBeUndefined();
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

  it("keeps a refused login an auth error for credential codes and for no code", () => {
    for (const serverResponseCode of [
      "AUTHENTICATIONFAILED",
      "AUTHORIZATIONFAILED",
      "EXPIRED",
      "PRIVACYREQUIRED",
      "CONTACTADMIN",
      undefined,
    ]) {
      const refused = Object.assign(new Error(`NO LOGIN ${password}`), {
        authenticationFailed: true,
        serverResponseCode,
      });
      expect(describeImapError(refused), String(serverResponseCode)).toBeInstanceOf(ImapAuthError);
    }
  });

  it("maps a login refused for a transient reason to a retryable error", () => {
    for (const serverResponseCode of ["UNAVAILABLE", "INUSE", "LIMIT", "SERVERBUG"]) {
      const refused = Object.assign(new Error(`NO [${serverResponseCode}] ${password}`), {
        authenticationFailed: true,
        serverResponseCode,
      });
      const mapped = describeImapError(refused);
      expect(mapped, serverResponseCode).not.toBeInstanceOf(ImapAuthError);
      expect(mapped).toBeInstanceOf(SafeImapError);
      expect(mapped.message).toBe(`IMAP error (${serverResponseCode})`);
      expect(mapped.message).not.toContain(password);
    }
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

  it("passes errors it already built through unchanged", () => {
    const tls = describeImapError(Object.assign(new Error("x"), { tlsFailed: true }));
    expect(describeImapError(tls)).toBe(tls);
    expect(describeImapError(tls).message).toBe("IMAP error (TLS failed)");
    const auth = describeImapError({ authenticationFailed: true });
    expect(describeImapError(auth)).toBe(auth);
  });
});

type StubOptions = {
  search?: unknown;
  stored?: boolean;
  fetched?: FetchMessageObject[];
  mailbox?: unknown;
};

function stubClient(options: StubOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    mailbox: "mailbox" in options ? options.mailbox : { uidValidity: 7n, uidNext: 50, exists: 3 },
    search: async (...args: unknown[]) => {
      calls.push({ method: "search", args });
      return options.search;
    },
    fetch: async function* (...args: unknown[]) {
      calls.push({ method: "fetch", args });
      yield* options.fetched ?? [];
    },
    messageFlagsAdd: async (...args: unknown[]) => {
      calls.push({ method: "messageFlagsAdd", args });
      return options.stored ?? true;
    },
    logout: async () => {},
    close: () => {},
  };
  return { client: client as unknown as SessionClient, calls };
}

describe("createSession", () => {
  it("throws when the server refuses a search instead of reporting no mail", async () => {
    for (const refused of [false, undefined]) {
      const session = createSession(stubClient({ search: refused }).client, true);
      await expect(session.searchSince(new Date())).rejects.toThrow("IMAP error (SearchFailed)");
      await expect(session.uidsAfter(10)).rejects.toBeInstanceOf(SafeImapError);
    }
  });

  it("returns search results and drops uids not after the last one", async () => {
    const session = createSession(stubClient({ search: [9] }).client, true);
    expect(await session.searchSince(new Date())).toEqual([9]);
    expect(await session.uidsAfter(9)).toEqual([]);
  });

  it("markSeen throws when the server rejects the STORE", async () => {
    const { client, calls } = stubClient({ stored: false });
    await expect(createSession(client, false).markSeen([1, 2])).rejects.toThrow(
      "IMAP error (StoreFailed)",
    );
    expect(calls).toEqual([
      { method: "messageFlagsAdd", args: [[1, 2], ["\\Seen"], { uid: true }] },
    ]);
  });

  it("markSeen stores \\Seen and refuses a read-only session with a safe code", async () => {
    const { client, calls } = stubClient({ stored: true });
    await createSession(client, false).markSeen([3]);
    expect(calls).toHaveLength(1);
    const readOnly = createSession(stubClient().client, true).markSeen([3]);
    await expect(readOnly).rejects.toMatchObject({ code: "ReadOnly" });
  });

  it("reports a missing mailbox with a safe code", async () => {
    const session = createSession(stubClient({ mailbox: false }).client, true);
    await expect(session.status()).rejects.toMatchObject({ code: "NoMailboxSelected" });
    const open = createSession(stubClient().client, true);
    expect(await open.status()).toEqual({ uidValidity: 7, uidNext: 50, exists: 3 });
  });

  it("keeps a message postal-mime cannot parse with its envelope only", async () => {
    const fetched = [imapMessage({ uid: 1 }), imapMessage({ uid: 2 }), imapMessage({ uid: 3 })];
    const parse = async (source: Buffer | string) => {
      if (fetched[1]!.source === source) {
        throw Object.assign(new Error("too deep"), { code: "EMAXNESTINGDEPTH" });
      }
      return PostalMime.parse(source);
    };
    const session = createSession(stubClient({ fetched }).client, true, parse);
    const messages = await session.fetchMessages([1, 2, 3]);
    expect(messages.map((m) => m.uid)).toEqual([1, 2, 3]);
    expect(messages[0]!.bodyText?.trim()).toBe("Invented plain body.");
    expect(messages[1]).toMatchObject({
      uid: 2,
      messageId: "<raw-1@example.org>",
      subject: "Invented subject",
      bodyText: null,
      bodyHtml: null,
      attachments: [],
      references: [],
    });
  });
});
