import { Readable } from "node:stream";
import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import type { FetchMessageObject, ListResponse } from "imapflow";
import imapflowFetch from "imapflow/lib/commands/fetch.js";
import { compiler as imapCompiler, parser as imapParser } from "imapflow/lib/handler/imap-handler.js";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER_LINES_TRUNCATED, ImapAuthError, LIST_HEADER_FIELDS, UNSUBSCRIBE_HEADER_FIELDS, trustOf, unsubscribeInfoOf } from "../../core/index.ts";
import {
  LIST_HEADERS_QUERY,
  WATCH_LOGOUT_CAP_MS,
  createFolderWith,
  runWatch,
  type WatchClient,
  SafeImapError,
  createSession,
  describeImapError,
  listRemoteFolders,
  parseMail,
  toFetchedMessage,
  toInlineParts,
  toRemoteFolders,
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

  it("maps Reply-To from the message's own header, empty without one", async () => {
    const withReplyTo = `Reply-To: Garden list <list@example.net>, b@example.net\r\n${RAW}`;
    const message = toFetchedMessage(
      imapMessage({ envelope: { ...imapMessage().envelope!, replyTo: [{ name: "Env", address: "env@example.org" }] } }),
      await PostalMime.parse(withReplyTo),
    );
    expect(message.replyTo).toEqual([
      { name: "Garden list", address: "list@example.net" },
      { name: null, address: "b@example.net" },
    ]);
    expect(toFetchedMessage(imapMessage(), await PostalMime.parse(RAW)).replyTo).toEqual([]);
  });

  it("reads Delivered-To and X-Original-To from the parsed headers: every occurrence, addresses only, lower case, at most 10", async () => {
    const delivered = [
      "Delivered-To: Alias@Example.org",
      "Delivered-To: owner@example.org",
      "X-Original-To: Invented <Second.Alias@example.org>",
      RAW,
    ].join("\r\n");
    expect(toFetchedMessage(imapMessage(), await PostalMime.parse(delivered)).deliveredTo).toEqual([
      "alias@example.org",
      "owner@example.org",
      "second.alias@example.org",
    ]);
    const many = [...Array.from({ length: 12 }, (_, i) => `Delivered-To: a${i}@example.org`), RAW].join("\r\n");
    expect(toFetchedMessage(imapMessage(), await PostalMime.parse(many)).deliveredTo).toHaveLength(10);
    expect(toFetchedMessage(imapMessage(), await PostalMime.parse(RAW)).deliveredTo).toEqual([]);
    // A fetch that read no headers leaves it absent (not known).
    expect(toFetchedMessage(imapMessage(), { headers: [], headerLines: [], attachments: [] }).deliveredTo).toBeUndefined();
  });

  it("reads the bulk headers from the fetched source (no extra fetch item, so nothing sets \\Seen)", async () => {
    const listed = [
      "List-Id: Invented news <news.example.net>",
      "List-Unsubscribe: <mailto:leave@example.net>",
      "Precedence: bulk",
      "Auto-Submitted: auto-generated",
      RAW,
    ].join("\r\n");
    expect(toFetchedMessage(imapMessage(), await PostalMime.parse(listed)).bulkHeaders).toEqual({
      listId: "Invented news <news.example.net>",
      listUnsubscribe: "<mailto:leave@example.net>",
      precedence: "bulk",
      autoSubmitted: "auto-generated",
    });
    expect(toFetchedMessage(imapMessage(), await PostalMime.parse(RAW)).bulkHeaders).toEqual({
      listId: null,
      listUnsubscribe: null,
      precedence: null,
      autoSubmitted: null,
    });
    // An unparsable source has no headers: the mark stays unknown.
    expect(toFetchedMessage(imapMessage(), { headers: [], headerLines: [], attachments: [] }).bulkHeaders).toBeUndefined();
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

  it("maps a login refused with an ALERT code to a retryable error", () => {
    const refused = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      serverResponseCode: "ALERT",
      response: `[ALERT] Invented notice ${password}`,
    });
    const mapped = describeImapError(refused);
    expect(mapped).not.toBeInstanceOf(ImapAuthError);
    expect(mapped).toBeInstanceOf(SafeImapError);
    expect(mapped.message).toBe("IMAP error (ALERT)");
  });

  it("maps a throttled login to a retryable error without passing on its text", () => {
    const replies = [
      "Too many simultaneous connections. (Failure)",
      "Login rate limit exceeded",
      "Account throttled",
      "Please try again later",
      "Temporary system problem",
    ];
    for (const text of replies) {
      for (const field of ["response", "responseText"] as const) {
        const refused = Object.assign(new Error("Command failed"), {
          authenticationFailed: true,
          [field]: `${text} ${password}`,
        });
        const mapped = describeImapError(refused);
        expect(mapped, `${field}: ${text}`).not.toBeInstanceOf(ImapAuthError);
        expect(mapped).toBeInstanceOf(SafeImapError);
        expect(mapped.message).toBe("IMAP error (LoginThrottled)");
        for (const leaked of [mapped.message, JSON.stringify({ ...mapped }), String(mapped.stack)]) {
          expect(leaked).not.toContain(password);
          expect(leaked).not.toContain(text);
        }
      }
    }
  });

  it("keeps a credential refusal an auth error whatever its text says", () => {
    for (const response of ["Invalid credentials (Failure)", "Too many failed attempts, bad password"]) {
      const refused = Object.assign(new Error("Command failed"), {
        authenticationFailed: true,
        serverResponseCode: "AUTHENTICATIONFAILED",
        response,
      });
      expect(describeImapError(refused), response).toBeInstanceOf(ImapAuthError);
    }
    // A plain wrong password, no code, no throttle words ("separate" is not "rate").
    const plain = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      response: "Use a separate app password",
    });
    expect(describeImapError(plain)).toBeInstanceOf(ImapAuthError);
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
  moved?: unknown;
  copied?: unknown;
  capabilities?: string[];
  enabled?: string[];
  fetched?: FetchMessageObject[];
  mailbox?: unknown;
  usable?: boolean;
  removed?: boolean;
  download?: unknown;
  appended?: unknown;
  deleted?: boolean;
};

function stubClient(options: StubOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    mailbox: "mailbox" in options ? options.mailbox : { path: "Drafts", uidValidity: 7n, uidNext: 50, exists: 3 },
    capabilities: new Map(
      (options.capabilities ?? ["IMAP4rev1", "MOVE", "UIDPLUS"]).map((name) => [name, true]),
    ),
    enabled: new Set(options.enabled ?? []),
    usable: options.usable ?? true,
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
      return "stored" in options ? options.stored : true;
    },
    messageFlagsRemove: async (...args: unknown[]) => {
      calls.push({ method: "messageFlagsRemove", args });
      return "removed" in options ? options.removed : true;
    },
    download: async (...args: unknown[]) => {
      calls.push({ method: "download", args });
      if (options.download instanceof Error) throw options.download;
      return options.download ?? {};
    },
    messageMove: async (...args: unknown[]) => {
      calls.push({ method: "messageMove", args });
      return options.moved;
    },
    messageCopy: async (...args: unknown[]) => {
      calls.push({ method: "messageCopy", args });
      return options.copied;
    },
    append: async (...args: unknown[]) => {
      calls.push({ method: "append", args });
      return "appended" in options ? options.appended : { destination: "Drafts", uidValidity: 7n, uid: 51 };
    },
    messageDelete: async (...args: unknown[]) => {
      calls.push({ method: "messageDelete", args });
      return "deleted" in options ? options.deleted : true;
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
  it("moveMessages moves by uid and maps COPYUID to a Map of numbers", async () => {
    const { client, calls } = stubClient({
      moved: { path: "INBOX", destination: "Trash", uidMap: new Map([[4, 104], [5, 105]]) },
    });
    const result = await createSession(client, false).moveMessages([4, 5], "Trash");
    expect(calls).toEqual([{ method: "messageMove", args: [[4, 5], "Trash", { uid: true }] }]);
    expect(result.moved).toBeInstanceOf(Map);
    expect([...result.moved!]).toEqual([[4, 104], [5, 105]]);
  });

  it("moveMessages returns null without a uid map", async () => {
    const { client } = stubClient({ moved: { path: "INBOX", destination: "Trash" } });
    expect(await createSession(client, false).moveMessages([4], "Trash")).toEqual({ moved: null });
  });

  it("moveMessages throws a safe error when the server refuses the move", async () => {
    for (const refused of [false, undefined]) {
      const { client } = stubClient({ moved: refused });
      const move = createSession(client, false).moveMessages([4], "Trash");
      await expect(move).rejects.toBeInstanceOf(SafeImapError);
      await expect(move).rejects.toThrow("IMAP error (MoveFailed)");
    }
  });

  it("moveMessages on a connection that dropped is a connection error, not a refusal", async () => {
    // imapflow's messageMove also resolves false when the socket closed mid-command.
    for (const refused of [false, undefined]) {
      const { client } = stubClient({ moved: refused, usable: false });
      const move = createSession(client, false).moveMessages([4], "Trash");
      await expect(move).rejects.toBeInstanceOf(SafeImapError);
      await expect(move).rejects.toMatchObject({ code: "ConnectionLost" });
      await expect(move).rejects.toThrow("IMAP error (ConnectionLost)");
    }
  });

  it("moveMessages refuses servers with neither MOVE nor UIDPLUS without a server call", async () => {
    // imapflow's fallback would be COPY + plain EXPUNGE, which also deletes every
    // other \\Deleted message in the folder.
    for (const capabilities of [["IMAP4rev1"], ["IMAP4rev1", "IMAP4rev2"]]) {
      const { client, calls } = stubClient({ capabilities, moved: { uidMap: new Map() } });
      const move = createSession(client, false).moveMessages([4], "Trash");
      await expect(move).rejects.toBeInstanceOf(SafeImapError);
      await expect(move).rejects.toMatchObject({ code: "MoveUnsupported" });
      expect(calls).toEqual([]);
    }
  });

  it("moveMessages calls the server with MOVE, with UIDPLUS only, or on IMAP4rev2", async () => {
    for (const [capabilities, enabled] of [
      [["IMAP4rev1", "MOVE"], []],
      [["IMAP4rev1", "UIDPLUS"], []],
      [["IMAP4rev2"], []],
      [["IMAP4rev1", "IMAP4rev2"], ["IMAP4REV2"]],
    ] as const) {
      const { client, calls } = stubClient({
        capabilities: [...capabilities],
        enabled: [...enabled],
        moved: { path: "INBOX", destination: "Trash" },
      });
      expect(await createSession(client, false).moveMessages([4], "Trash")).toEqual({ moved: null });
      expect(calls.map((c) => c.method), capabilities.join(" ")).toEqual(["messageMove"]);
    }
  });

  it("moveMessages with no uids returns an empty map without a server call", async () => {
    const { client, calls } = stubClient({ moved: false });
    const result = await createSession(client, false).moveMessages([], "Trash");
    expect(result.moved).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("moveMessages maps a thrown imapflow error from codes only", async () => {
    const client = {
      ...stubClient().client,
      messageMove: async () => {
        throw Object.assign(new Error("A5 NO [TRYCREATE] invented-password"), { code: "ETIMEOUT" });
      },
    } as unknown as SessionClient;
    const move = createSession(client, false).moveMessages([4], "Trash");
    await expect(move).rejects.toThrow("IMAP error (ETIMEOUT)");
  });

  it("moveMessages refuses a read-only session without calling the server", async () => {
    const { client, calls } = stubClient({ moved: { uidMap: new Map() } });
    await expect(createSession(client, true).moveMessages([4], "Trash")).rejects.toMatchObject({
      code: "ReadOnly",
    });
    expect(calls).toEqual([]);
  });

  it("copyMessages sends UID COPY only and maps COPYUID to a Map of numbers", async () => {
    const { client, calls } = stubClient({
      copied: { path: "[Gmail]/All Mail", destination: "INBOX", uidMap: new Map([[4, 204]]) },
    });
    const result = await createSession(client, false).copyMessages([4], "INBOX");
    expect(calls).toEqual([{ method: "messageCopy", args: [[4], "INBOX", { uid: true }] }]);
    expect([...result.copied!]).toEqual([[4, 204]]);
    const bare = stubClient({ copied: { path: "[Gmail]/All Mail", destination: "INBOX" } });
    expect(await createSession(bare.client, false).copyMessages([4], "INBOX")).toEqual({ copied: null });
  });

  it("copyMessages maps a refusal, a dropped connection and a read-only session to safe codes", async () => {
    for (const refused of [false, undefined]) {
      const { client } = stubClient({ copied: refused });
      await expect(createSession(client, false).copyMessages([4], "INBOX")).rejects.toMatchObject({ code: "CopyFailed" });
      const dropped = stubClient({ copied: refused, usable: false });
      await expect(createSession(dropped.client, false).copyMessages([4], "INBOX")).rejects.toMatchObject({ code: "ConnectionLost" });
    }
    const { client, calls } = stubClient({ copied: { uidMap: new Map() } });
    await expect(createSession(client, true).copyMessages([4], "INBOX")).rejects.toMatchObject({ code: "ReadOnly" });
    expect(calls).toEqual([]);
    const thrown = {
      ...stubClient().client,
      messageCopy: async () => {
        throw Object.assign(new Error("A5 NO invented-password"), { code: "ETIMEOUT" });
      },
    } as unknown as SessionClient;
    await expect(createSession(thrown, false).copyMessages([4], "INBOX")).rejects.toThrow("IMAP error (ETIMEOUT)");
  });

  it("copyMessages with no uids returns an empty map without a server call", async () => {
    const { client, calls } = stubClient({ copied: false });
    expect((await createSession(client, false).copyMessages([], "INBOX")).copied).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("fetchMessages and fetchFlags carry the Gmail message id", async () => {
    const fetched = [
      imapMessage({ uid: 1, emailId: "1789000000000000101" }),
      imapMessage({ uid: 2, emailId: undefined, flags: new Set(["\\Seen"]) }),
    ];
    const { client, calls } = stubClient({ fetched });
    const session = createSession(client, true);
    const messages = await session.fetchMessages([1, 2]);
    expect(messages.map((m) => m.gmMsgId)).toEqual(["1789000000000000101", null]);
    const flags = await session.fetchFlags([1, 2]);
    expect(flags).toEqual([
      { uid: 1, seen: true, flagged: true, gmMsgId: "1789000000000000101" },
      { uid: 2, seen: true, flagged: false, gmMsgId: null },
    ]);
    const flagsQuery = calls.filter((c) => c.method === "fetch")[1]!.args[1];
    expect(flagsQuery).toMatchObject({ uid: true, flags: true, emailId: true });
    expect(flagsQuery).not.toHaveProperty("source");
  });

  it("setFlags adds and removes \\Seen / \\Flagged by uid, leaving absent fields alone", async () => {
    const { client, calls } = stubClient();
    const session = createSession(client, false);
    await session.setFlags([1, 2], { seen: true, flagged: false });
    await session.setFlags([3], { flagged: true });
    await session.setFlags([4], { seen: false });
    expect(calls).toEqual([
      { method: "messageFlagsAdd", args: [[1, 2], ["\\Seen"], { uid: true }] },
      { method: "messageFlagsRemove", args: [[1, 2], ["\\Flagged"], { uid: true }] },
      { method: "messageFlagsAdd", args: [[3], ["\\Flagged"], { uid: true }] },
      { method: "messageFlagsRemove", args: [[4], ["\\Seen"], { uid: true }] },
    ]);
  });

  it("setFlags throws StoreFailed when the server refuses an add or a remove", async () => {
    for (const refused of [false, undefined]) {
      const add = stubClient({ stored: refused as boolean });
      await expect(createSession(add.client, false).setFlags([1], { flagged: true })).rejects.toMatchObject({
        code: "StoreFailed",
        message: "IMAP error (StoreFailed)",
      });
      const remove = stubClient({ removed: refused as boolean });
      await expect(createSession(remove.client, false).setFlags([1], { seen: false })).rejects.toMatchObject({
        code: "StoreFailed",
      });
    }
  });

  it("setFlags refuses a read-only session and sends nothing for no uids or no change", async () => {
    const readOnly = stubClient();
    await expect(createSession(readOnly.client, true).setFlags([1], { seen: true })).rejects.toMatchObject({
      code: "ReadOnly",
    });
    expect(readOnly.calls).toEqual([]);
    const idle = stubClient();
    await createSession(idle.client, false).setFlags([], { seen: true, flagged: true });
    await createSession(idle.client, false).setFlags([5], {});
    expect(idle.calls).toEqual([]);
  });

  it("setFlags passes on a thrown STORE error without its text", async () => {
    const { client } = stubClient();
    (client as unknown as { messageFlagsRemove: unknown }).messageFlagsRemove = async () => {
      throw Object.assign(new Error("A5 NO secret-server-text"), { response: "secret-server-text" });
    };
    const error = (await createSession(client, false)
      .setFlags([1], { flagged: false })
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(SafeImapError);
    expect(error.message).not.toContain("secret-server-text");
  });

  it("fetchRaw downloads the whole message by uid (BODY.PEEK[]) and returns its bytes", async () => {
    const content = Readable.from([Buffer.from(RAW.slice(0, 100)), Buffer.from(RAW.slice(100))]);
    const { client, calls } = stubClient({
      download: { meta: { expectedSize: RAW.length, contentType: "message/rfc822" }, content },
    });
    const bytes = await createSession(client, true).fetchRaw(42, 1000);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString()).toBe(RAW);
    // No part: imapflow fetches `source`, which it always asks as BODY.PEEK[]<start.len>.
    // maxBytes + 1 lets imapflow stop pulling chunks just past the cap so the overflow is seen.
    expect(calls).toEqual([{ method: "download", args: ["42", undefined, { uid: true, maxBytes: 1001 }] }]);
  });

  it("fetchRaw refuses before reading when the reported size is over the cap", async () => {
    const content = Readable.from([Buffer.from(RAW)]);
    const { client } = stubClient({
      download: { meta: { expectedSize: 5000 }, content },
    });
    await expect(createSession(client, true).fetchRaw(42, 4999)).rejects.toMatchObject({ code: "TooLarge" });
    expect(content.destroyed).toBe(true);
  });

  it("fetchRaw stops and throws TooLarge when more than the cap arrives", async () => {
    let pulled = 0;
    const content = new Readable({
      read() {
        pulled += 1;
        this.push(pulled > 50 ? null : Buffer.alloc(64, 0x61));
      },
    });
    const { client } = stubClient({ download: { meta: {}, content } });
    await expect(createSession(client, true).fetchRaw(42, 100)).rejects.toMatchObject({
      code: "TooLarge",
      message: "IMAP error (TooLarge)",
    });
    expect(content.destroyed).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("fetchRaw returns a message exactly at the cap", async () => {
    const content = Readable.from([Buffer.alloc(60, 0x61), Buffer.alloc(40, 0x62)]);
    const { client } = stubClient({ download: { meta: { expectedSize: 100 }, content } });
    const bytes = await createSession(client, true).fetchRaw(42, 100);
    expect(bytes.byteLength).toBe(100);
  });

  it("fetchRaw throws NotFound when the uid is gone", async () => {
    const { client } = stubClient({ download: {} });
    await expect(createSession(client, true).fetchRaw(42, 100)).rejects.toMatchObject({ code: "NotFound" });
  });

  it("fetchRaw passes on download and stream errors without server text", async () => {
    const thrown = stubClient({
      download: Object.assign(new Error("A9 NO secret-server-text"), { code: "DownloadIncomplete" }),
    });
    const first = (await createSession(thrown.client, true)
      .fetchRaw(42, 100)
      .catch((e: unknown) => e)) as Error;
    expect(first).toMatchObject({ code: "DownloadIncomplete", message: "IMAP error (DownloadIncomplete)" });

    const content = new Readable({
      read() {
        this.destroy(new Error("stream says secret-server-text"));
      },
    });
    const failing = stubClient({ download: { meta: {}, content } });
    const second = (await createSession(failing.client, true)
      .fetchRaw(42, 100)
      .catch((e: unknown) => e)) as Error;
    expect(second).toBeInstanceOf(SafeImapError);
    expect(second.message).not.toContain("secret-server-text");
  });

  it("parseMail is the parser fetchMessages uses: same mapping from the same bytes", async () => {
    const session = createSession(stubClient({ fetched: [imapMessage()] }).client, true);
    const [fetched] = await session.fetchMessages([42]);
    const fromBuffer = toFetchedMessage(imapMessage(), await parseMail(Buffer.from(RAW)));
    const fromBytes = toFetchedMessage(
      imapMessage(),
      await parseMail(new Uint8Array(Buffer.from(RAW))),
    );
    expect(fromBuffer).toEqual(fetched);
    expect(fromBytes).toEqual(fetched);
    // Same options as the fetch path: attachment content comes back as ArrayBuffer.
    const parsed = await parseMail(new Uint8Array(Buffer.from(RAW)));
    expect(parsed.attachments.map((a) => a.content instanceof ArrayBuffer)).toEqual([true, true]);
  });

  it("fetchMessages extracts inline images", async () => {
    const session = createSession(stubClient({ fetched: [imapMessage()] }).client, true);
    const [message] = await session.fetchMessages([42]);
    expect(message!.inlineParts).toHaveLength(1);
    expect(message!.inlineParts[0]).toMatchObject({ contentId: "logo@example.org", mimeType: "image/png" });
    expect(message!.inlineParts[0]!.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(message!.inlineParts[0]!.data).toString("base64")).toBe("iVBORw0KGgo=");
  });
});

function listEntry(
  path: string,
  flags: string[],
  specialUse?: string,
  specialUseSource?: ListResponse["specialUseSource"],
  extra: Partial<ListResponse> = {},
): ListResponse {
  const parts = path.split("/");
  return {
    path,
    pathAsListed: path,
    name: parts[parts.length - 1]!,
    delimiter: "/",
    parent: parts.slice(0, -1),
    parentPath: parts.slice(0, -1).join("/"),
    flags: new Set(flags),
    specialUse,
    specialUseSource,
    listed: true,
    subscribed: true,
    ...extra,
  };
}

const GMAIL_LIST: ListResponse[] = [
  listEntry("INBOX", ["\\HasNoChildren"], "\\Inbox", "name"),
  listEntry("[Gmail]", ["\\HasChildren", "\\Noselect"]),
  listEntry("[Gmail]/All Mail", ["\\All", "\\HasNoChildren"], "\\All", "extension"),
  listEntry("[Gmail]/Drafts", ["\\Drafts", "\\HasNoChildren"], "\\Drafts", "extension"),
  listEntry("[Gmail]/Important", ["\\HasNoChildren", "\\Important"]),
  listEntry("[Gmail]/Sent Mail", ["\\HasNoChildren", "\\Sent"], "\\Sent", "extension"),
  listEntry("[Gmail]/Spam", ["\\HasNoChildren", "\\Junk"], "\\Junk", "extension"),
  listEntry("[Gmail]/Starred", ["\\Flagged", "\\HasNoChildren"], "\\Flagged", "extension"),
  listEntry("[Gmail]/Trash", ["\\HasNoChildren", "\\Trash"], "\\Trash", "extension"),
  listEntry("Work", ["\\HasNoChildren"]),
];

const ICLOUD_LIST: ListResponse[] = [
  listEntry("INBOX", [], "\\Inbox", "name"),
  listEntry("Sent Messages", [], "\\Sent", "name"),
  listEntry("Drafts", [], "\\Drafts", "name"),
  listEntry("Junk", [], "\\Junk", "name"),
  listEntry("Deleted Messages", [], "\\Trash", "name"),
  listEntry("Archive", [], "\\Archive", "name"),
  listEntry("Notes", []),
];

describe("toRemoteFolders", () => {
  it("maps a Gmail listing and skips the virtual Starred and Important folders", () => {
    expect(toRemoteFolders(GMAIL_LIST)).toEqual([
      { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true },
      { path: "[Gmail]", name: "[Gmail]", delimiter: "/", specialUse: null, selectable: false },
      { path: "[Gmail]/All Mail", name: "All Mail", delimiter: "/", specialUse: "all", selectable: true },
      { path: "[Gmail]/Drafts", name: "Drafts", delimiter: "/", specialUse: "drafts", selectable: true },
      { path: "[Gmail]/Sent Mail", name: "Sent Mail", delimiter: "/", specialUse: "sent", selectable: true },
      { path: "[Gmail]/Spam", name: "Spam", delimiter: "/", specialUse: "junk", selectable: true },
      { path: "[Gmail]/Trash", name: "Trash", delimiter: "/", specialUse: "trash", selectable: true },
      { path: "Work", name: "Work", delimiter: "/", specialUse: null, selectable: true },
    ]);
  });

  it("maps an iCloud listing whose special use comes from folder names", () => {
    expect(toRemoteFolders(ICLOUD_LIST).map((f) => [f.path, f.specialUse, f.selectable])).toEqual([
      ["INBOX", "inbox", true],
      ["Sent Messages", "sent", true],
      ["Drafts", "drafts", true],
      ["Junk", "junk", true],
      ["Deleted Messages", "trash", true],
      ["Archive", "archive", true],
      ["Notes", null, true],
    ]);
  });

  it("treats INBOX as the Inbox in any case, even without a special-use flag", () => {
    const folders = toRemoteFolders([listEntry("Inbox", []), listEntry("inbox.child", [])]);
    expect(folders.map((f) => f.specialUse)).toEqual(["inbox", null]);
  });

  it("marks \\Noselect and \\NonExistent folders not selectable", () => {
    const folders = toRemoteFolders([
      listEntry("Parent", ["\\Noselect"]),
      listEntry("Phantom", ["\\NonExistent"]),
      listEntry("Lower", ["\\noselect"]),
    ]);
    expect(folders.map((f) => f.selectable)).toEqual([false, false, false]);
  });

  it("ignores special uses it does not model and entries LIST did not report", () => {
    const folders = toRemoteFolders([
      listEntry("Flagged", [], "\\Flagged", "name"),
      listEntry("Odd", [], "\\Something"),
      listEntry("Gone", [], undefined, undefined, { listed: false }),
    ]);
    expect(folders).toEqual([
      { path: "Flagged", name: "Flagged", delimiter: "/", specialUse: null, selectable: true },
      { path: "Odd", name: "Odd", delimiter: "/", specialUse: null, selectable: true },
    ]);
  });
});

describe("listRemoteFolders", () => {
  it("lists with special-use resolution and maps the result", async () => {
    const calls: unknown[][] = [];
    const client = {
      list: async (...args: unknown[]) => {
        calls.push(args);
        return ICLOUD_LIST;
      },
    };
    const folders = await listRemoteFolders(client);
    expect(folders).toHaveLength(7);
    expect(calls).toEqual([[]]);
  });

  it("maps a LIST failure from codes only", async () => {
    const client = {
      list: async () => {
        throw Object.assign(new Error("A1 BAD invented-password"), { code: "ECONNRESET" });
      },
    };
    await expect(listRemoteFolders(client)).rejects.toThrow("IMAP error (ECONNRESET)");
  });
});

function attachment(overrides: Partial<Email["attachments"][number]> = {}): Email["attachments"][number] {
  return {
    filename: null,
    mimeType: "image/png",
    disposition: "inline",
    contentId: "<part@example.org>",
    content: new Uint8Array(16).buffer,
    ...overrides,
  };
}

describe("toInlineParts", () => {
  it("keeps image parts with a content id, strips the brackets and copies the bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const parts = toInlineParts([
      attachment({ contentId: "<a@example.org>", content: bytes.buffer }),
      attachment({ contentId: " b@example.org ", disposition: null, related: true, mimeType: "image/jpeg" }),
      attachment({ contentId: "<c@example.org>", disposition: "attachment", mimeType: "image/gif" }),
    ]);
    expect(parts.map((p) => [p.contentId, p.mimeType])).toEqual([
      ["a@example.org", "image/png"],
      ["b@example.org", "image/jpeg"],
      ["c@example.org", "image/gif"],
    ]);
    expect(parts[0]!.data).toBeInstanceOf(Uint8Array);
    expect([...parts[0]!.data]).toEqual([1, 2, 3]);
  });

  it("drops non-images, parts without a content id and string content", () => {
    expect(
      toInlineParts([
        attachment({ mimeType: "application/pdf" }),
        attachment({ mimeType: "text/html", contentId: "<h@example.org>" }),
        attachment({ contentId: undefined }),
        attachment({ contentId: "<>" }),
        attachment({ content: "aGVsbG8=", encoding: "base64" }),
      ]),
    ).toEqual([]);
  });

  it("drops parts over 512 KB and stops at 2 MB per message", () => {
    const kb = 1024;
    const parts = toInlineParts([
      attachment({ contentId: "<big@example.org>", content: new Uint8Array(512 * kb + 1).buffer }),
      ...[1, 2, 3, 4].map((n) =>
        attachment({ contentId: `<p${n}@example.org>`, content: new Uint8Array(512 * kb).buffer }),
      ),
      attachment({ contentId: "<over@example.org>", content: new Uint8Array(1).buffer }),
    ]);
    expect(parts.map((p) => p.contentId)).toEqual([
      "p1@example.org",
      "p2@example.org",
      "p3@example.org",
      "p4@example.org",
    ]);
    expect(parts.reduce((sum, p) => sum + p.data.byteLength, 0)).toBe(2 * 1024 * kb);
  });

  it("never throws on odd attachment shapes", () => {
    const odd = [
      { mimeType: undefined, contentId: "<x@example.org>", content: null },
      attachment({ mimeType: "IMAGE/PNG", contentId: "<upper@example.org>" }),
    ] as unknown as Email["attachments"];
    expect(toInlineParts(odd).map((p) => [p.contentId, p.mimeType])).toEqual([
      ["upper@example.org", "image/png"],
    ]);
  });
});

describe("slice 3b writes", () => {
  const guardFetch = (overrides: Partial<FetchMessageObject> = {}) =>
    imapMessage({
      uid: 12,
      size: 300,
      envelope: { messageId: "<draft-1@example.org>" },
      source: undefined,
      ...overrides,
    });

  it("reports UIDPLUS and Gmail from the advertised capabilities", () => {
    expect(createSession(stubClient().client, false).capabilities()).toEqual({ uidplus: true, gmail: false });
    expect(
      createSession(stubClient({ capabilities: ["IMAP4rev1", "X-GM-EXT-1"] }).client, false).capabilities(),
    ).toEqual({ uidplus: false, gmail: true });
  });

  it("appends to the session's own folder and maps APPENDUID", async () => {
    const { client, calls } = stubClient();
    const raw = new TextEncoder().encode("Subject: Invented\r\n\r\nbody");
    await expect(createSession(client, false).appendMessage(raw, ["\\Draft", "\\Seen"])).resolves.toEqual({
      uidValidity: 7,
      uid: 51,
    });
    expect(calls).toHaveLength(1);
    const [path, content, flags] = calls[0]!.args as [string, Buffer, string[]];
    expect(path).toBe("Drafts");
    expect(Buffer.from(content).equals(Buffer.from(raw))).toBe(true);
    expect(flags).toEqual(["\\Draft", "\\Seen"]);
  });

  it("an append without APPENDUID has no uid; a refused one throws AppendFailed", async () => {
    const raw = new Uint8Array([65]);
    await expect(
      createSession(stubClient({ appended: { destination: "Drafts", seq: 4, uid: 99 } }).client, false).appendMessage(
        raw,
        [],
      ),
    ).resolves.toEqual({ uidValidity: null, uid: null });
    await expect(createSession(stubClient({ appended: false }).client, false).appendMessage(raw, [])).rejects.toMatchObject({
      code: "AppendFailed",
    });
  });

  it("read-only sessions refuse every write before any command", async () => {
    const { client, calls } = stubClient();
    const session = createSession(client, true);
    await expect(session.appendMessage(new Uint8Array([1]), [])).rejects.toMatchObject({ code: "ReadOnly" });
    await expect(session.expungeOwn(12, { messageId: "<draft-1@example.org>", size: 300 })).rejects.toMatchObject({
      code: "ReadOnly",
    });
    expect(calls).toEqual([]);
  });

  it("finds by Message-ID with an exact match after the substring SEARCH", async () => {
    const { client, calls } = stubClient({
      search: [12, 13],
      fetched: [
        guardFetch({ uid: 13, envelope: { messageId: "<x-draft-1@example.org>" } }),
        guardFetch({ uid: 12, envelope: { messageId: "<draft-1@example.org>" } }),
      ],
    });
    await expect(createSession(client, true).findByMessageId("draft-1@example.org")).resolves.toEqual([12]);
    expect(calls[0]).toEqual({
      method: "search",
      args: [{ header: { "message-id": "draft-1@example.org" } }, { uid: true }],
    });
    expect(calls[1]!.args[1]).toEqual({ uid: true, envelope: true, size: true });
  });

  it("finds bracketed and bare ids alike, and nothing for an empty id", async () => {
    const { client } = stubClient({ search: [12], fetched: [guardFetch()] });
    await expect(createSession(client, true).findByMessageId("<draft-1@example.org>")).resolves.toEqual([12]);
    const empty = stubClient({ search: [12] });
    await expect(createSession(empty.client, true).findByMessageId("<>")).resolves.toEqual([]);
    expect(empty.calls).toEqual([]);
  });

  it("without UIDPLUS expungeOwn throws before any command", async () => {
    const { client, calls } = stubClient({ capabilities: ["IMAP4rev1", "MOVE"], fetched: [guardFetch()] });
    await expect(
      createSession(client, false).expungeOwn(12, { messageId: "<draft-1@example.org>", size: 300 }),
    ).rejects.toMatchObject({ code: "ExpungeUnsupported" });
    expect(calls).toEqual([]);
  });

  it("IMAP4rev2 without an advertised UIDPLUS is refused too", async () => {
    const { client, calls } = stubClient({ capabilities: ["IMAP4rev2"], enabled: ["IMAP4REV2"] });
    await expect(
      createSession(client, false).expungeOwn(12, { messageId: "<draft-1@example.org>", size: 300 }),
    ).rejects.toMatchObject({ code: "ExpungeUnsupported" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["another Message-ID", { envelope: { messageId: "<other@example.org>" } }],
    ["another size", { size: 301 }],
    ["no Message-ID", { envelope: {} }],
  ])("refuses on a guard mismatch (%s) and deletes nothing", async (_label, overrides) => {
    const { client, calls } = stubClient({ fetched: [guardFetch(overrides as Partial<FetchMessageObject>)] });
    await expect(
      createSession(client, false).expungeOwn(12, { messageId: "<draft-1@example.org>", size: 300 }),
    ).rejects.toMatchObject({ code: "GuardMismatch" });
    expect(calls.map((c) => c.method)).toEqual(["fetch"]);
  });

  it("refuses a vanished uid", async () => {
    const { client, calls } = stubClient({ fetched: [] });
    await expect(
      createSession(client, false).expungeOwn(12, { messageId: "<draft-1@example.org>", size: 300 }),
    ).rejects.toMatchObject({ code: "GuardMismatch" });
    expect(calls.map((c) => c.method)).toEqual(["fetch"]);
  });

  it("with UIDPLUS and a matching guard deletes exactly that uid by UID", async () => {
    const { client, calls } = stubClient({ fetched: [guardFetch()] });
    await createSession(client, false).expungeOwn(12, { messageId: "draft-1@example.org", size: 300 });
    expect(calls.map((c) => c.method)).toEqual(["fetch", "messageDelete"]);
    expect(calls[0]!.args.slice(0, 3)).toEqual(["12", { uid: true, envelope: true, size: true }, { uid: true }]);
    expect(calls[1]!.args).toEqual(["12", { uid: true }]);
    expect(calls.some((c) => c.method === "messageFlagsAdd")).toBe(false);
  });

  it("a refused expunge clears our \\Deleted again and throws ExpungeFailed", async () => {
    const { client, calls } = stubClient({ fetched: [guardFetch()], deleted: false });
    await expect(
      createSession(client, false).expungeOwn(12, { messageId: "<draft-1@example.org>", size: 300 }),
    ).rejects.toMatchObject({ code: "ExpungeFailed" });
    expect(calls.at(-1)).toEqual({ method: "messageFlagsRemove", args: ["12", ["\\Deleted"], { uid: true }] });
  });
});

describe("fetchListHeaders", () => {
  it("UID FETCHes only the list header fields and returns each block by uid", async () => {
    const block = Buffer.from("List-Id: <news.example.net>\r\n\r\n");
    const { client, calls } = stubClient({
      fetched: [
        { seq: 1, uid: 5, headers: block } as FetchMessageObject,
        // No header section in the answer: nothing to judge by.
        { seq: 2, uid: 6 } as FetchMessageObject,
      ],
    });
    const found = await createSession(client, true).fetchListHeaders([5, 6, 7]);
    expect(found).toEqual([{ uid: 5, block: new Uint8Array(block) }]);
    expect(calls).toEqual([{ method: "fetch", args: [[5, 6, 7], LIST_HEADERS_QUERY, { uid: true }] }]);
    expect(LIST_HEADERS_QUERY).toEqual({ uid: true, headers: [...LIST_HEADER_FIELDS] });
  });

  it("sends nothing for no uids and maps a failure to a safe error", async () => {
    const { client, calls } = stubClient();
    expect(await createSession(client, true).fetchListHeaders([])).toEqual([]);
    expect(calls).toEqual([]);
    const failing = stubClient();
    (failing.client as { fetch: unknown }).fetch = async function* () {
      throw Object.assign(new Error("server said: secret text"), { code: "ETIMEOUT" });
    };
    await expect(createSession(failing.client, true).fetchListHeaders([1])).rejects.toMatchObject({ code: "ETIMEOUT" });
  });

  it("imapflow 2.11 turns the query into BODY.PEEK[HEADER.FIELDS (...)] by UID and the answer into a headers Buffer", async () => {
    const block = Buffer.from("List-Unsubscribe: <mailto:u@example.net>\r\n\r\n");
    let wire = "";
    const connection = {
      state: 3,
      states: { SELECTED: 3 },
      mailbox: { path: "INBOX", uidValidity: 7n },
      capabilities: new Map([["IMAP4rev1", true]]),
      enabled: new Set<string>(),
      id: "c1",
      log: { warn: () => {}, debug: () => {}, trace: () => {} },
      async exec(
        command: string,
        attributes: unknown,
        options: { untagged: { FETCH: (untagged: unknown) => Promise<void> } },
      ) {
        wire = String(await imapCompiler({ tag: "A1", command, attributes } as never));
        const answer = `* 1 FETCH (UID 5 BODY[HEADER.FIELDS (LIST-ID LIST-UNSUBSCRIBE PRECEDENCE AUTO-SUBMITTED)] {${block.length}}\r\n)`;
        await options.untagged.FETCH(await imapParser(Buffer.from(answer), { literals: [block] } as never));
        return { next: () => {} };
      },
    };
    const result = await imapflowFetch(connection as never, [5, 6] as never, LIST_HEADERS_QUERY, { uid: true });
    expect(wire).toBe(
      "A1 UID FETCH 5,6 (UID BODY.PEEK[HEADER.FIELDS (List-Id List-Unsubscribe Precedence Auto-Submitted)])",
    );
    expect(wire).not.toMatch(/BODY\[|RFC822(?!\.SIZE)|STORE|\\Seen/);
    expect(result?.list[0]?.uid).toBe(5);
    expect(Buffer.isBuffer(result?.list[0]?.headers)).toBe(true);
    expect(String(result?.list[0]?.headers)).toBe(String(block));
  });
});

describe("fetchHeaderFields", () => {
  it("UID FETCHes exactly the given fields (BODY.PEEK HEADER.FIELDS) and returns each block by uid", async () => {
    const block = Buffer.from("List-Unsubscribe: <mailto:u@example.net>\r\n\r\n");
    const { client, calls } = stubClient({ fetched: [{ seq: 1, uid: 9, headers: block } as FetchMessageObject] });
    const found = await createSession(client, true).fetchHeaderFields([9], UNSUBSCRIBE_HEADER_FIELDS);
    expect(found).toEqual([{ uid: 9, block: new Uint8Array(block) }]);
    expect(calls).toEqual([
      { method: "fetch", args: [[9], { uid: true, headers: [...UNSUBSCRIBE_HEADER_FIELDS] }, { uid: true }] },
    ]);
  });
});

/** Synthetic: invented selectors, signatures and ids only. */
const TRIAGE_RAW = [
  "Received: from mx.example.net by mx.google.com; Tue, 10 Nov 2026 09:00:01 +0000",
  "X-Google-Smtp-Source: invented",
  "Authentication-Results: mx.google.com;",
  "       dkim=pass header.i=@news.example.com header.s=sel1 header.b=AbCd;",
  "       spf=pass smtp.mailfrom=news.example.com",
  "DKIM-Signature: v=1; a=rsa-sha256; d=news.example.com; s=sel1;",
  "\th=From:Subject:List-Unsubscribe:",
  "\t List-Unsubscribe-Post; bh=aW52ZW50ZWQ=; b=AbCd",
  "\t EfGh",
  "DKIM-Signature: v=1; a=rsa-sha256; d=relay.example.org; s=other; h=From; bh=eA==; b=ZzZz",
  "From: News <news@example.com>",
  "Subject: Invented news",
  "List-Unsubscribe: <https://news.example.com/u/1>, <mailto:u@news.example.com>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  "Message-ID: <n-1@example.com>",
  "",
  "Invented body.",
  "",
].join("\r\n");

describe("toFetchedMessage unsubscribe headers", () => {
  it("keeps the unsubscribe and trace header lines in message order, unfolded, two DKIM-Signatures included", async () => {
    const parsed = await PostalMime.parse(TRIAGE_RAW);
    const fetched = toFetchedMessage(imapMessage({ source: Buffer.from(TRIAGE_RAW) }), parsed);
    const lines = fetched.unsubscribeHeaders ?? [];
    expect(lines.map((line) => line.key)).toEqual([
      "received",
      "x-google-smtp-source",
      "authentication-results",
      "dkim-signature",
      "dkim-signature",
      "from",
      "list-unsubscribe",
      "list-unsubscribe-post",
    ]);
    expect(lines.every((line) => !/[\r\n]/.test(line.value))).toBe(true);
    // The folded h= still names both list headers once parsed.
    expect(trustOf(lines, "gmail", "news.example.com", "news.example.com")).toBe("covered");
  });

  it("leaves unsubscribeHeaders absent when the fetch read no headers", () => {
    const fetched = toFetchedMessage(imapMessage({ source: undefined }), { headers: [], headerLines: [], attachments: [] });
    expect(fetched.unsubscribeHeaders).toBeUndefined();
  });

  it("matches header names in any case and keeps at most 64 lines plus the truncation mark", () => {
    const headers = Array.from({ length: 80 }, (_, i) => ({ key: i === 0 ? "List-Unsubscribe" : "received", originalKey: "Received", value: `v${i}` }));
    const fetched = toFetchedMessage(imapMessage(), { headers, headerLines: [], attachments: [] } as unknown as Email);
    expect(fetched.unsubscribeHeaders).toHaveLength(65);
    expect(fetched.unsubscribeHeaders?.[0]).toEqual({ key: "list-unsubscribe", value: "v0" });
    expect(fetched.unsubscribeHeaders?.at(-1)).toEqual(HEADER_LINES_TRUNCATED);
  });

  it("carries a second List-Unsubscribe past the cap, so the repeat rule sees it (review item 2)", () => {
    const headers = [
      { key: "list-unsubscribe", value: "<https://u.example.com/x>" },
      ...Array.from({ length: 70 }, (_, i) => ({ key: "received", value: `hop ${i}` })),
      { key: "list-unsubscribe", value: "<https://evil.example/u>" },
      { key: "list-unsubscribe-post", value: "List-Unsubscribe=One-Click" },
    ];
    const fetched = toFetchedMessage(imapMessage(), { headers, headerLines: [], attachments: [] } as unknown as Email);
    const lines = fetched.unsubscribeHeaders ?? [];
    expect(lines.filter((line) => line.key === "list-unsubscribe")).toHaveLength(2);
    expect(lines.filter((line) => line.key === "list-unsubscribe-post")).toHaveLength(1);
    expect(unsubscribeInfoOf(lines, "gmail", { name: null, address: "news@u.example.com" })).toMatchObject({ trust: "not_covered", oneClick: false });
  });
});

type FakeWatch = {
  client: WatchClient;
  emitter: EventEmitter;
  calls: string[];
  state: { usable: boolean; mailbox: unknown };
  idleAnswers: (() => Promise<boolean | undefined>)[];
};

/** A fake imapflow client: records every method called, so a test can check nothing writes. */
function fakeWatchClient(options: {
  capabilities?: string[];
  connect?: () => Promise<void>;
  open?: () => Promise<unknown>;
  logout?: () => Promise<void>;
} = {}): FakeWatch {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  const state = { usable: false, mailbox: null as unknown };
  const idleAnswers: (() => Promise<boolean | undefined>)[] = [];
  const base = {
    capabilities: new Map((options.capabilities ?? ["IMAP4rev1", "IDLE"]).map((name) => [name, true])),
    enabled: new Set<string>(),
    get usable() {
      return state.usable;
    },
    get mailbox() {
      return state.mailbox;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return base;
    },
    connect: async () => {
      await (options.connect?.() ?? Promise.resolve());
      state.usable = true;
    },
    mailboxOpen: async (path: string, opts: unknown) => {
      calls.push(`mailboxOpen ${path} ${JSON.stringify(opts)}`);
      await (options.open?.() ?? Promise.resolve());
      state.mailbox = { path };
      return state.mailbox;
    },
    idle: async () => {
      const next = idleAnswers.shift();
      return next ? next() : new Promise<undefined>(() => {});
    },
    logout: async () => {
      await (options.logout?.() ?? Promise.resolve());
      state.usable = false;
    },
    close: () => {
      state.usable = false;
    },
  };
  const client = new Proxy(base, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value === "function" && key !== "on") {
        return (...args: unknown[]) => {
          if (key !== "mailboxOpen") calls.push(String(key));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (value === undefined && typeof key === "string") {
        // Any other client method (STORE, MOVE, COPY, APPEND, CREATE...) is recorded and refused.
        return (...args: unknown[]) => {
          calls.push(`FORBIDDEN ${key} ${JSON.stringify(args)}`);
          throw new Error("not allowed");
        };
      }
      return value;
    },
  }) as unknown as WatchClient;
  return { client, emitter, calls, state, idleAnswers };
}

const ALLOWED_WATCH_CALLS = /^(connect|mailboxOpen .*|idle|logout|close)$/;
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("runWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("EXAMINEs the given path (read-only) and calls back only when the count grew", async () => {
    const fake = fakeWatchClient();
    const changes: string[] = [];
    const controller = new AbortController();
    const end = runWatch(fake.client, "Boîte/Inbox", (change) => changes.push(change), controller.signal);
    await flush();
    expect(fake.calls).toContain('mailboxOpen Boîte/Inbox {"readOnly":true}');
    fake.emitter.emit("exists", { path: "x", count: 5, prevCount: 4 });
    fake.emitter.emit("exists", { path: "x", count: 3, prevCount: 4 });
    fake.emitter.emit("expunge", { seq: 1 });
    fake.emitter.emit("flags", { seq: 2 });
    expect(changes).toEqual(["exists", "expunge", "flags"]);
    controller.abort();
    expect(await end).toEqual({ kind: "aborted" });
    expect(fake.calls.every((call) => ALLOWED_WATCH_CALLS.test(call))).toBe(true);
  });

  it("re-enters idle() after each resolution", async () => {
    const fake = fakeWatchClient();
    fake.idleAnswers.push(async () => undefined, async () => undefined);
    const controller = new AbortController();
    const end = runWatch(fake.client, "INBOX", () => {}, controller.signal);
    await flush();
    expect(fake.calls.filter((call) => call === "idle")).toHaveLength(3);
    controller.abort();
    await end;
  });

  it("idle() returning false ends the watch as dropped IdleRefused without another idle", async () => {
    const fake = fakeWatchClient();
    fake.idleAnswers.push(async () => false);
    const end = await runWatch(fake.client, "INBOX", () => {}, new AbortController().signal);
    expect(end).toEqual({ kind: "dropped", code: "IdleRefused" });
    expect(fake.calls.filter((call) => call === "idle")).toHaveLength(1);
    expect(fake.calls).toContain("logout");
  });

  it("a close or an error ends the watch as dropped with a safe code", async () => {
    const closing = fakeWatchClient();
    const closed = runWatch(closing.client, "INBOX", () => {}, new AbortController().signal);
    await flush();
    closing.emitter.emit("close");
    expect(await closed).toEqual({ kind: "dropped", code: "ConnectionClosed" });

    const failing = fakeWatchClient();
    const lines: string[] = [];
    const failed = runWatch(failing.client, "INBOX", () => {}, new AbortController().signal, (line) => lines.push(line));
    await flush();
    failing.emitter.emit("error", Object.assign(new Error("server said: private text"), { code: "ETIMEOUT" }));
    expect(await failed).toEqual({ kind: "dropped", code: "ETIMEOUT" });
    expect(lines.join("\n")).not.toContain("private");
  });

  it("an abort ends the watch within the logout cap even when LOGOUT never answers", async () => {
    vi.useFakeTimers();
    const fake = fakeWatchClient({ logout: () => new Promise(() => {}) });
    const controller = new AbortController();
    const end = runWatch(fake.client, "INBOX", () => {}, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(WATCH_LOGOUT_CAP_MS);
    expect(await end).toEqual({ kind: "aborted" });
    expect(fake.calls.slice(-2)).toEqual(["logout", "close"]);
  });

  it("no IDLE capability: logout, unsupported, nothing opened", async () => {
    const fake = fakeWatchClient({ capabilities: ["IMAP4rev1"] });
    expect(await runWatch(fake.client, "INBOX", () => {}, new AbortController().signal)).toEqual({ kind: "unsupported" });
    expect(fake.calls.some((call) => call.startsWith("mailboxOpen"))).toBe(false);
    expect(fake.calls).toContain("logout");
  });

  it("a refused login is auth, a throttled one throttled", async () => {
    const auth = fakeWatchClient({
      connect: async () => {
        throw Object.assign(new Error("x"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
      },
    });
    expect(await runWatch(auth.client, "INBOX", () => {}, new AbortController().signal)).toEqual({ kind: "auth" });
    const throttled = fakeWatchClient({
      connect: async () => {
        throw Object.assign(new Error("x"), { authenticationFailed: true, response: "Too many simultaneous connections" });
      },
    });
    expect(await runWatch(throttled.client, "INBOX", () => {}, new AbortController().signal)).toEqual({ kind: "throttled" });
    const limit = fakeWatchClient({
      connect: async () => {
        throw Object.assign(new Error("x"), { serverResponseCode: "LIMIT" });
      },
    });
    expect(await runWatch(limit.client, "INBOX", () => {}, new AbortController().signal)).toEqual({ kind: "throttled" });
  });

  it("an already aborted signal ends at once without connecting", async () => {
    const fake = fakeWatchClient();
    const controller = new AbortController();
    controller.abort();
    expect(await runWatch(fake.client, "INBOX", () => {}, controller.signal)).toEqual({ kind: "aborted" });
    expect(fake.calls.some((call) => call.startsWith("mailboxOpen"))).toBe(false);
  });
});

describe("createFolderWith", () => {
  it("returns the path and created: true or false (ALREADYEXISTS)", async () => {
    const made = { mailboxCreate: async (name: string) => ({ path: name, created: true }) };
    expect(await createFolderWith(made as never, "Snoozed")).toEqual({ path: "Snoozed", created: true });
    const existed = { mailboxCreate: async (name: string) => ({ path: name, created: false }) };
    expect(await createFolderWith(existed as never, "Snoozed")).toEqual({ path: "Snoozed", created: false });
  });

  it("a refusal or no answer is CreateFailed without the server text", async () => {
    const refused = {
      mailboxCreate: async () => {
        throw Object.assign(new Error("NO private text"), { responseStatus: "NO" });
      },
    };
    const error = await createFolderWith(refused as never, "Snoozed").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CreateFailed" });
    expect(String((error as Error).message)).not.toContain("private");
    const none = { mailboxCreate: async () => undefined };
    await expect(createFolderWith(none as never, "Snoozed")).rejects.toMatchObject({ code: "CreateFailed" });
  });
});

const DEV_RAW = [
  "From: GitHub <notifications@github.com>",
  "Subject: [example-org/demo] Run failed: CI - main (abc1234)",
  "List-ID: example-org/demo <demo.example-org.github.com>",
  "X-GitHub-Reason: ci_activity",
  "X-GitLab-Project-Path: Group/Demo",
  "X-Unrelated: kept out",
  "Message-ID: <dev-1@example.com>",
  "",
  "Invented body.",
  "",
].join("\r\n");

describe("toFetchedMessage dev headers (slice 3g)", () => {
  it("keeps the DEV_HEADER_FIELDS lines with lower-case keys, and List-Id in the bulk headers", async () => {
    const parsed = await PostalMime.parse(DEV_RAW);
    const fetched = toFetchedMessage(imapMessage({ source: Buffer.from(DEV_RAW) }), parsed);
    expect(fetched.devHeaders).toEqual([
      { key: "x-github-reason", value: "ci_activity" },
      { key: "x-gitlab-project-path", value: "Group/Demo" },
    ]);
    expect(fetched.bulkHeaders?.listId).toBe("example-org/demo <demo.example-org.github.com>");
  });

  it("leaves devHeaders absent when the fetch read no headers", () => {
    const fetched = toFetchedMessage(imapMessage({ source: undefined }), { headers: [], headerLines: [], attachments: [] });
    expect(fetched.devHeaders).toBeUndefined();
  });
});
