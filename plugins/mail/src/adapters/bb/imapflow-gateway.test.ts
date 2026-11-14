import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import type { FetchMessageObject, ListResponse } from "imapflow";
import { describe, expect, it } from "vitest";
import { ImapAuthError } from "../../core/index.ts";
import {
  SafeImapError,
  createSession,
  describeImapError,
  listRemoteFolders,
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
  capabilities?: string[];
  enabled?: string[];
  fetched?: FetchMessageObject[];
  mailbox?: unknown;
  usable?: boolean;
};

function stubClient(options: StubOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    mailbox: "mailbox" in options ? options.mailbox : { uidValidity: 7n, uidNext: 50, exists: 3 },
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
      return options.stored ?? true;
    },
    messageMove: async (...args: unknown[]) => {
      calls.push({ method: "messageMove", args });
      return options.moved;
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
