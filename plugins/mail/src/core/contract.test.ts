import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { MAIL_CHANGED_CHANNEL, OUTBOX_CHANGED_CHANNEL, rpcSchemas } from "./contract.ts";
import {
  accountSchema,
  draftViewSchema,
  newAccountInputSchema,
  outboxRowSchema,
  outboxStateSchema,
  sendErrorKindSchema,
  smtpSecuritySchema,
  folderSchema,
  messageActionSchema,
  messageHeaderSchema,
  messageSummarySchema,
  specialUseSchema,
  statusViewSchema,
  threadSummarySchema,
} from "./model.ts";

const SECRET_KEY = /pass|secret|seal|key/i;

/** The 19 owner-only methods slice 3b adds. */
const COMPOSE_METHODS = [
  "compose_new",
  "compose_prepare",
  "compose_open",
  "compose_save",
  "compose_discard",
  "compose_attachment_begin",
  "compose_attachment_chunk",
  "compose_attachment_finish",
  "compose_attachment_remove",
  "compose_send",
  "outbox_list",
  "outbox_cancel",
  "outbox_send_now",
  "outbox_retry",
  "outbox_resend",
  "outbox_dismiss",
  "recipients_suggest",
  "accounts_smtp_test",
  "accounts_smtp_set",
] as const;

/** Header-injection payloads every header field must refuse. */
const LINE_BREAKS = ["x\r\nBcc: eve@example.net", "x\nBcc: eve@example.net", "x\rX", "x\u0000y"];

/** Every object key reachable from a schema, through arrays and nesting. */
function keysOf(schema: z.ZodType): string[] {
  const def = (schema as unknown as { def: Record<string, unknown> }).def;
  if (def.type === "object") {
    const shape = def.shape as Record<string, z.ZodType>;
    return Object.entries(shape).flatMap(([key, child]) => [key, ...keysOf(child)]);
  }
  if (def.type === "array") return keysOf(def.element as z.ZodType);
  if (def.type === "nullable" || def.type === "optional") {
    return keysOf(def.innerType as z.ZodType);
  }
  if (def.type === "tuple") return (def.items as z.ZodType[]).flatMap(keysOf);
  if (def.type === "union") return (def.options as z.ZodType[]).flatMap(keysOf);
  return [];
}

describe("rpcSchemas", () => {
  it("declares exactly the slice-1 methods plus the slice-2, 3a and 3b additions", () => {
    expect(Object.keys(rpcSchemas).sort()).toEqual(
      [
        ...COMPOSE_METHODS,
        "status_get",
        "accounts_test",
        "accounts_add",
        "accounts_remove",
        "sync_now",
        "threads_list",
        "thread_get",
        "message_body",
        "message_agent_text",
        "message_open",
        "search",
        "folders_list",
        "message_action",
        "images_allow_sender",
        "images_disallow_sender",
        "message_source",
        "download_ticket",
      ].sort(),
    );
  });

  it("gives every method an input and an output schema", () => {
    for (const method of Object.values(rpcSchemas)) {
      expect(typeof method.input.safeParse).toBe("function");
      expect(typeof method.output.safeParse).toBe("function");
    }
  });

  it("bounds the list and search limits", () => {
    expect(
      rpcSchemas.threads_list.input.safeParse({
        scope: { kind: "account", accountId: "a", folder: "INBOX" },
        cursor: null,
        limit: 101,
      }).success,
    ).toBe(false);
    expect(
      rpcSchemas.search.input.safeParse({ query: "x", accountId: null, limit: 51 }).success,
    ).toBe(false);
    expect(
      rpcSchemas.search.input.safeParse({ query: "", accountId: null, limit: 10 }).success,
    ).toBe(false);
  });

  it("lists threads of one account's folder or of a role across accounts", () => {
    const parse = (scope: unknown) =>
      rpcSchemas.threads_list.input.safeParse({ scope, cursor: null, limit: 10 }).success;
    expect(parse({ kind: "account", accountId: "a", folder: "INBOX" })).toBe(true);
    expect(parse({ kind: "account", accountId: "a" })).toBe(false);
    expect(parse({ kind: "account", accountId: "", folder: "INBOX" })).toBe(false);
    expect(parse({ kind: "all", role: "inbox" })).toBe(true);
    expect(parse({ kind: "all", role: "flagged" })).toBe(false);
    expect(parse({ kind: "all" })).toBe(false);
    expect(parse({ kind: "some", role: "inbox" })).toBe(false);
    // The slice-2 shape is gone.
    expect(
      rpcSchemas.threads_list.input.safeParse({
        accountId: "a",
        folder: "INBOX",
        cursor: null,
        limit: 10,
      }).success,
    ).toBe(false);
  });

  it("carries the flagged state on thread rows", () => {
    expect(Object.keys(threadSummarySchema.shape)).toContain("flagged");
  });

  it("bounds message_action to 1..200 ids and the nine actions", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `m_${i}`);
    const parse = (messageIds: string[], action: string) =>
      rpcSchemas.message_action.input.safeParse({ messageIds, folder: "INBOX", action }).success;
    expect(parse(ids(1), "spam")).toBe(true);
    expect(parse(ids(200), "delete")).toBe(true);
    expect(parse(ids(3), "mark_read")).toBe(true);
    expect(parse(ids(3), "unflag")).toBe(true);
    expect(parse([], "archive")).toBe(false);
    expect(parse(ids(201), "not_spam")).toBe(false);
    expect(parse(ids(1), "expunge")).toBe(false);
    expect(parse([""], "spam")).toBe(false);
    expect(parse(["x".repeat(257)], "spam")).toBe(false);
    expect(
      rpcSchemas.message_action.input.safeParse({ messageIds: ["m"], folder: "", action: "spam" })
        .success,
    ).toBe(false);
    expect(messageActionSchema.options).toEqual([
      "spam",
      "not_spam",
      "archive",
      "delete",
      "mark_read",
      "mark_unread",
      "flag",
      "unflag",
      "move",
    ]);
  });

  it("takes exactly one of folder and role in message_action", () => {
    const parse = (extra: Record<string, unknown>) =>
      rpcSchemas.message_action.input.safeParse({ messageIds: ["m"], action: "flag", ...extra })
        .success;
    expect(parse({ folder: "INBOX" })).toBe(true);
    expect(parse({ role: "inbox" })).toBe(true);
    expect(parse({})).toBe(false);
    expect(parse({ folder: "INBOX", role: "inbox" })).toBe(false);
    expect(parse({ role: "flagged" })).toBe(false);
  });

  it("takes a destination with move and only with move", () => {
    const parse = (action: string, extra: Record<string, unknown>) =>
      rpcSchemas.message_action.input.safeParse({
        messageIds: ["m"],
        folder: "INBOX",
        action,
        ...extra,
      }).success;
    expect(parse("move", { destination: "Work" })).toBe(true);
    expect(parse("move", {})).toBe(false);
    expect(parse("move", { destination: "" })).toBe(false);
    expect(parse("archive", { destination: "Work" })).toBe(false);
    expect(parse("mark_read", { destination: "Work" })).toBe(false);
  });

  it("reports message_action per account and source folder", () => {
    const group = {
      accountId: "a",
      folder: "INBOX",
      queued: 2,
      destination: "Trash",
      error: null,
    };
    const parse = (output: unknown) => rpcSchemas.message_action.output.safeParse(output).success;
    expect(parse({ groups: [group] })).toBe(true);
    expect(parse({ groups: [{ ...group, destination: null, error: "Refused" }] })).toBe(true);
    expect(parse({ groups: [{ ...group, queued: -1 }] })).toBe(false);
    expect(parse({ groups: [{ ...group, error: undefined }] })).toBe(false);
    expect(parse({ queued: 2, destination: "Trash" })).toBe(false);
  });

  it("shapes message_source", () => {
    expect(rpcSchemas.message_source.input.safeParse({ messageId: "m" }).success).toBe(true);
    expect(rpcSchemas.message_source.input.safeParse({ messageId: "" }).success).toBe(false);
    const source = {
      headers: [["Subject", "Hello"]],
      structure: ["multipart/mixed", "  text/plain"],
      size: 1200,
      uid: 7,
      folder: "INBOX",
      accountEmail: "owner@example.org",
    };
    expect(rpcSchemas.message_source.output.safeParse(source).success).toBe(true);
    expect(
      rpcSchemas.message_source.output.safeParse({ ...source, headers: [["Subject"]] }).success,
    ).toBe(false);
  });

  it("shapes download_ticket: a partId with an attachment only", () => {
    const parse = (input: unknown) => rpcSchemas.download_ticket.input.safeParse(input).success;
    expect(parse({ kind: "eml", messageId: "m" })).toBe(true);
    expect(parse({ kind: "attachment", messageId: "m", partId: "1" })).toBe(true);
    expect(parse({ kind: "attachment", messageId: "m" })).toBe(false);
    expect(parse({ kind: "eml", messageId: "m", partId: "1" })).toBe(false);
    expect(parse({ kind: "raw", messageId: "m" })).toBe(false);
    expect(parse({ kind: "eml", messageId: "" })).toBe(false);
    expect(
      rpcSchemas.download_ticket.output.safeParse({ url: "/x?t=abc", fileName: "a.eml" }).success,
    ).toBe(true);
  });

  it("reports whether remote images are allowed with a body", () => {
    const body = { messageId: "m", text: null, html: null, htmlTruncated: false };
    expect(rpcSchemas.message_body.output.safeParse(body).success).toBe(false);
    expect(
      rpcSchemas.message_body.output.safeParse({ ...body, remoteImagesAllowed: true }).success,
    ).toBe(true);
  });

  it("shapes the folder and image-sender methods", () => {
    expect(rpcSchemas.folders_list.input.safeParse({ accountId: "a" }).success).toBe(true);
    expect(rpcSchemas.folders_list.input.safeParse({ accountId: null }).success).toBe(true);
    expect(rpcSchemas.folders_list.output.safeParse({ folders: [], roles: [] }).success).toBe(true);
    expect(rpcSchemas.folders_list.output.safeParse({ folders: [] }).success).toBe(false);
    expect(
      rpcSchemas.folders_list.output.safeParse({
        folders: [],
        roles: [{ role: "inbox", unreadCount: 3, totalCount: 9 }],
      }).success,
    ).toBe(true);
    expect(rpcSchemas.images_allow_sender.input.safeParse({ messageId: "m" }).success).toBe(true);
    expect(
      rpcSchemas.images_allow_sender.output.safeParse({ address: "a@example.org" }).success,
    ).toBe(true);
    expect(
      rpcSchemas.images_disallow_sender.input.safeParse({
        accountId: "a",
        address: "a@example.org",
      }).success,
    ).toBe(true);
    expect(rpcSchemas.images_disallow_sender.output.safeParse({ removed: false }).success).toBe(
      true,
    );
  });

  it("bounds the new string inputs", () => {
    expect(rpcSchemas.folders_list.input.safeParse({ accountId: "" }).success).toBe(false);
    expect(rpcSchemas.folders_list.input.safeParse({ accountId: "a".repeat(257) }).success).toBe(
      false,
    );
    expect(rpcSchemas.images_allow_sender.input.safeParse({ messageId: "" }).success).toBe(false);
    const disallow = (accountId: string, address: string) =>
      rpcSchemas.images_disallow_sender.input.safeParse({ accountId, address }).success;
    expect(disallow("a", "a@b")).toBe(true);
    expect(disallow("a", "ab")).toBe(false);
    expect(disallow("a", `${"x".repeat(310)}@example.org`)).toBe(false);
    expect(disallow("", "a@example.org")).toBe(false);
    expect(
      rpcSchemas.threads_list.input.safeParse({
        scope: { kind: "account", accountId: "a", folder: "" },
        cursor: null,
        limit: 1,
      }).success,
    ).toBe(false);
  });

  it("names the realtime channel", () => {
    expect(MAIL_CHANGED_CHANNEL).toBe("mail-changed");
  });
});

describe("slice-2 model", () => {
  it("lists the special-use roles", () => {
    expect(specialUseSchema.options).toEqual([
      "inbox",
      "sent",
      "drafts",
      "junk",
      "trash",
      "archive",
      "all",
    ]);
  });

  it("parses a folder", () => {
    const folder = {
      accountId: "a",
      path: "[Gmail]/Spam",
      name: "Spam",
      specialUse: "junk",
      selectable: true,
      unreadCount: 0,
      totalCount: 3,
    };
    expect(folderSchema.safeParse(folder).success).toBe(true);
    expect(folderSchema.safeParse({ ...folder, specialUse: null }).success).toBe(true);
    expect(folderSchema.safeParse({ ...folder, specialUse: "flagged" }).success).toBe(false);
  });

  it("carries the folder on message summaries and headers", () => {
    expect(Object.keys(messageSummarySchema.shape)).toContain("folder");
    expect(Object.keys(messageHeaderSchema.shape)).toContain("folder");
  });
});

describe("credential-free views", () => {
  it.each([
    ["statusViewSchema", statusViewSchema],
    ["accountSchema", accountSchema],
    ["folderSchema", folderSchema],
    ...Object.entries(rpcSchemas).map(
      ([name, method]) => [`${name} output`, method.output as z.ZodType] as [string, z.ZodType],
    ),
  ])("%s has no secret-like key", (_name, schema) => {
    const keys = keysOf(schema);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => SECRET_KEY.test(key))).toEqual([]);
  });

  it("walks into the slice-3a shapes", () => {
    expect(keysOf(rpcSchemas.message_action.output)).toEqual(
      expect.arrayContaining(["groups", "accountId", "error"]),
    );
    expect(keysOf(rpcSchemas.folders_list.output)).toEqual(
      expect.arrayContaining(["roles", "role", "unreadCount"]),
    );
    expect(keysOf(rpcSchemas.message_source.output)).toContain("accountEmail");
    expect(keysOf(rpcSchemas.threads_list.input)).toEqual(
      expect.arrayContaining(["scope", "kind", "accountId", "folder", "role"]),
    );
  });
});

describe("slice-3b contract", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) =>
    rpcSchemas[method].input.safeParse(input).success;

  const save = (overrides: Record<string, unknown> = {}) => ({
    draftId: "d_1",
    baseRevision: 3,
    accountId: "acc_1",
    to: ["Anna <anna@example.org>"],
    cc: [],
    bcc: ["bob@example.com"],
    subject: "Garden plans",
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] },
    ...overrides,
  });

  it("adds exactly 19 methods to the 17 before it", () => {
    expect(COMPOSE_METHODS).toHaveLength(19);
    expect(Object.keys(rpcSchemas)).toHaveLength(36);
  });

  it("refuses empty and overlong ids in every new method", () => {
    const idInputs: [keyof typeof rpcSchemas, Record<string, unknown>, string][] = [
      ["compose_new", {}, "accountId"],
      ["compose_prepare", { kind: "reply" }, "messageId"],
      ["compose_open", {}, "draftId"],
      ["compose_open", {}, "draftMessageId"],
      ["compose_discard", {}, "draftId"],
      ["compose_attachment_remove", { attachmentId: "a" }, "draftId"],
      ["compose_attachment_remove", { draftId: "d" }, "attachmentId"],
      ["outbox_cancel", {}, "id"],
      ["outbox_send_now", {}, "id"],
      ["outbox_retry", {}, "id"],
      ["outbox_resend", {}, "id"],
      ["outbox_dismiss", {}, "id"],
      ["outbox_list", {}, "accountId"],
    ];
    for (const [method, rest, key] of idInputs) {
      expect(parses(method, { ...rest, [key]: "x" })).toBe(true);
      expect(parses(method, { ...rest, [key]: "" })).toBe(false);
      expect(parses(method, { ...rest, [key]: "x".repeat(257) })).toBe(false);
    }
    expect(parses("outbox_list", { accountId: null })).toBe(true);
  });

  it("prepares only a reply, a reply-all or a forward", () => {
    for (const kind of ["reply", "reply_all", "forward"]) {
      expect(parses("compose_prepare", { kind, messageId: "m" })).toBe(true);
    }
    expect(parses("compose_prepare", { kind: "new", messageId: "m" })).toBe(false);
    expect(parses("compose_prepare", { kind: "send", messageId: "m" })).toBe(false);
  });

  it("opens by exactly one of draftId and draftMessageId", () => {
    expect(parses("compose_open", { draftId: "d" })).toBe(true);
    expect(parses("compose_open", { draftMessageId: "m" })).toBe(true);
    expect(parses("compose_open", { draftId: "d", draftMessageId: "m" })).toBe(false);
    expect(parses("compose_open", {})).toBe(false);
  });

  it("saves a draft and refuses line breaks in every header field", () => {
    expect(parses("compose_save", save())).toBe(true);
    expect(parses("compose_save", save({ saveToServer: true }))).toBe(true);
    for (const bad of LINE_BREAKS) {
      expect(parses("compose_save", save({ subject: bad }))).toBe(false);
      for (const field of ["to", "cc", "bcc"]) {
        expect(parses("compose_save", save({ [field]: [`anna@example.org${bad}`] }))).toBe(false);
      }
    }
  });

  it("bounds the draft's subject, recipient lists and document", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@example.com`);
    expect(parses("compose_save", save({ subject: "s".repeat(998) }))).toBe(true);
    expect(parses("compose_save", save({ subject: "s".repeat(999) }))).toBe(false);
    for (const field of ["to", "cc", "bcc"]) {
      expect(parses("compose_save", save({ [field]: list(100) }))).toBe(true);
      expect(parses("compose_save", save({ [field]: list(101) }))).toBe(false);
      expect(parses("compose_save", save({ [field]: [`${"a".repeat(310)}@example.com`] }))).toBe(false);
    }
    expect(parses("compose_save", save({ baseRevision: -1 }))).toBe(false);
    expect(parses("compose_save", save({ baseRevision: 1.5 }))).toBe(false);
    expect(parses("compose_save", save({ doc: "<p>html</p>" }))).toBe(false);
    expect(
      parses("compose_save", save({ doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(2_100_000) }] }] } })),
    ).toBe(false);
    expect(
      rpcSchemas.compose_save.output.safeParse({ revision: 4 }).success &&
        rpcSchemas.compose_save.output.safeParse({ conflict: true, revision: 5 }).success,
    ).toBe(true);
  });

  it("bounds attachment uploads and refuses line breaks in their names and types", () => {
    const begin = (overrides: Record<string, unknown> = {}) => ({
      draftId: "d",
      fileName: "plan.pdf",
      mimeType: "application/pdf",
      size: 1200,
      ...overrides,
    });
    expect(parses("compose_attachment_begin", begin())).toBe(true);
    expect(parses("compose_attachment_begin", begin({ size: 25 * 1024 * 1024 }))).toBe(true);
    expect(parses("compose_attachment_begin", begin({ size: 25 * 1024 * 1024 + 1 }))).toBe(false);
    expect(parses("compose_attachment_begin", begin({ size: -1 }))).toBe(false);
    expect(parses("compose_attachment_begin", begin({ fileName: "" }))).toBe(false);
    expect(parses("compose_attachment_begin", begin({ fileName: "a".repeat(256) }))).toBe(false);
    expect(parses("compose_attachment_begin", begin({ mimeType: "a".repeat(128) }))).toBe(false);
    for (const bad of LINE_BREAKS) {
      expect(parses("compose_attachment_begin", begin({ fileName: bad }))).toBe(false);
      expect(parses("compose_attachment_begin", begin({ mimeType: `text/plain${bad}` }))).toBe(false);
    }

    const chunk = (dataBase64: string, offset = 0) => ({ uploadId: "u", offset, dataBase64 });
    const maxBase64 = Math.ceil((512 * 1024) / 3) * 4;
    expect(parses("compose_attachment_chunk", chunk("aGVsbG8="))).toBe(true);
    expect(parses("compose_attachment_chunk", chunk("A".repeat(maxBase64)))).toBe(true);
    expect(parses("compose_attachment_chunk", chunk("A".repeat(maxBase64 + 4)))).toBe(false);
    expect(parses("compose_attachment_chunk", chunk("aGVsbG8"))).toBe(false);
    expect(parses("compose_attachment_chunk", chunk("aGVs\nbG8="))).toBe(false);
    expect(parses("compose_attachment_chunk", chunk("aGVs*bG8="))).toBe(false);
    expect(parses("compose_attachment_chunk", chunk("aGVsbG8=", -1))).toBe(false);

    const sha = "a".repeat(64);
    expect(parses("compose_attachment_finish", { uploadId: "u", sha256: sha })).toBe(true);
    expect(parses("compose_attachment_finish", { uploadId: "u", sha256: sha.toUpperCase() })).toBe(false);
    expect(parses("compose_attachment_finish", { uploadId: "u", sha256: "a".repeat(63) })).toBe(false);
  });

  it("sends with a UUID requestId", () => {
    const send = (requestId: string) => ({ draftId: "d", baseRevision: 2, requestId });
    expect(parses("compose_send", send("6f1c2a52-3b5e-4f0a-9c1d-2e7b8a9c0d1e"))).toBe(true);
    expect(parses("compose_send", send("not-a-uuid"))).toBe(false);
    expect(parses("compose_send", send(""))).toBe(false);
  });

  it("suggests recipients for a 1-64 character prefix without line breaks", () => {
    expect(parses("recipients_suggest", { prefix: "an" })).toBe(true);
    expect(parses("recipients_suggest", { prefix: "" })).toBe(false);
    expect(parses("recipients_suggest", { prefix: "a".repeat(65) })).toBe(false);
    for (const bad of LINE_BREAKS) expect(parses("recipients_suggest", { prefix: bad })).toBe(false);
    const suggestion = { name: null, address: "a@example.org" };
    expect(
      rpcSchemas.recipients_suggest.output.safeParse({ suggestions: Array(10).fill(suggestion) }).success,
    ).toBe(true);
    expect(
      rpcSchemas.recipients_suggest.output.safeParse({ suggestions: Array(11).fill(suggestion) }).success,
    ).toBe(false);
  });

  it("takes SMTP settings with TLS or STARTTLS only, and a clean host and username", () => {
    const smtp = (overrides: Record<string, unknown> = {}) => ({
      accountId: "acc_1",
      host: "smtp.example.org",
      port: 587,
      security: "starttls",
      ...overrides,
    });
    for (const method of ["accounts_smtp_test", "accounts_smtp_set"] as const) {
      expect(parses(method, smtp())).toBe(true);
      expect(parses(method, smtp({ username: "login@example.org" }))).toBe(true);
      expect(parses(method, smtp({ security: "tls", port: 465 }))).toBe(true);
      for (const security of ["none", "plain", "plaintext", "ssl", ""]) {
        expect(parses(method, smtp({ security }))).toBe(false);
      }
      expect(parses(method, smtp({ port: 0 }))).toBe(false);
      expect(parses(method, smtp({ port: 65536 }))).toBe(false);
      expect(parses(method, smtp({ host: "" }))).toBe(false);
      expect(parses(method, smtp({ host: "smtp.example.org:25" }))).toBe(false);
      expect(parses(method, smtp({ host: "smtp example.org" }))).toBe(false);
      for (const bad of LINE_BREAKS) {
        expect(parses(method, smtp({ host: `smtp.example.org${bad}` }))).toBe(false);
        expect(parses(method, smtp({ username: bad }))).toBe(false);
      }
      expect(rpcSchemas[method].output.safeParse({ ok: false, reason: "auth" }).success).toBe(true);
    }
  });

  it("has no plaintext SMTP security value", () => {
    expect(smtpSecuritySchema.options).toEqual(["tls", "starttls"]);
  });

  it("names the outbox states and error kinds; no cancelled state", () => {
    expect(outboxStateSchema.options).toEqual([
      "queued",
      "held",
      "sending",
      "sent",
      "appending",
      "failed",
      "unknown",
      "sent_no_copy",
      "done",
    ]);
    expect(outboxStateSchema.options).not.toContain("cancelled");
    expect(sendErrorKindSchema.options).toEqual([
      "auth",
      "tls",
      "connect",
      "timeout_before_data",
      "temporary",
      "rejected_all",
      "rejected_message",
      "too_large",
      "unknown_after_data",
      "no_sent_folder",
      "append_failed",
    ]);
  });

  it("names the outbox realtime channel", () => {
    expect(OUTBOX_CHANGED_CHANNEL).toBe("outbox-changed");
  });

  it("shapes an outbox row and a draft view", () => {
    const row = {
      id: "6f1c2a52-3b5e-4f0a-9c1d-2e7b8a9c0d1e",
      accountId: "acc_1",
      subject: "Garden plans",
      state: "failed",
      errorKind: "temporary",
      rejected: [],
      sendAfter: "2026-11-15T10:00:10.000Z",
      attempts: 1,
    };
    expect(outboxRowSchema.safeParse(row).success).toBe(true);
    expect(outboxRowSchema.safeParse({ ...row, state: "cancelled" }).success).toBe(false);
    expect(outboxRowSchema.safeParse({ ...row, errorKind: "smtp said no" }).success).toBe(false);
    const draft = {
      id: "d_1",
      accountId: "acc_1",
      kind: "reply",
      to: [{ name: "Anna", address: "anna@example.org" }],
      cc: [],
      bcc: [],
      subject: "Re: Garden plans",
      doc: { type: "doc", content: [{ type: "paragraph" }] },
      attachments: [{ id: "a_1", fileName: "plan.pdf", mimeType: "application/pdf", size: 1200 }],
      revision: 1,
      serverCopy: "none",
      queued: false,
      continues: false,
      import: { html: "<p>quoted</p>", into: "quote" },
    };
    expect(draftViewSchema.safeParse(draft).success).toBe(true);
    expect(draftViewSchema.safeParse({ ...draft, import: null }).success).toBe(true);
    expect(draftViewSchema.safeParse({ ...draft, serverCopy: "maybe" }).success).toBe(false);
    expect(
      rpcSchemas.compose_open.output.safeParse({ draft, warning: "original_unavailable" }).success,
    ).toBe(true);
    expect(rpcSchemas.compose_open.output.safeParse({ draft, warning: "other" }).success).toBe(false);
  });

  it("puts no credential, sealed password or raw MIME in any new output", () => {
    const forbidden = /pass|secret|seal|key|^mime$|raw|bcc_?header|envelope/i;
    for (const method of COMPOSE_METHODS) {
      const keys = keysOf(rpcSchemas[method].output);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => forbidden.test(key))).toEqual([]);
    }
    expect(keysOf(rpcSchemas.compose_open.output)).toEqual(
      expect.arrayContaining(["draft", "attachments", "revision", "import", "html"]),
    );
    expect(keysOf(rpcSchemas.outbox_list.output)).toEqual(
      expect.arrayContaining(["rows", "state", "errorKind", "rejected"]),
    );
  });

  it("tells the page whether an account can send", () => {
    expect(Object.keys(accountSchema.shape)).toContain("smtpConfigured");
    expect(keysOf(rpcSchemas.status_get.output)).toContain("smtpConfigured");
    expect(keysOf(rpcSchemas.accounts_add.output)).toContain("smtpConfigured");
  });
});

describe("newAccountInputSchema SMTP fields", () => {
  const base = { email: "owner@example.org", password: "app-password" };

  it("needs SMTP host, port and security for another server", () => {
    const other = { ...base, preset: "other", host: "imap.example.org" };
    expect(newAccountInputSchema.safeParse(other).success).toBe(false);
    expect(
      newAccountInputSchema.safeParse({ ...other, smtpHost: "smtp.example.org", smtpPort: 587 }).success,
    ).toBe(false);
    expect(
      newAccountInputSchema.safeParse({
        ...other,
        smtpHost: "smtp.example.org",
        smtpPort: 587,
        smtpSecurity: "starttls",
      }).success,
    ).toBe(true);
  });

  it("takes iCloud and Gmail without SMTP fields", () => {
    expect(newAccountInputSchema.safeParse({ ...base, preset: "icloud" }).success).toBe(true);
    expect(newAccountInputSchema.safeParse({ ...base, preset: "gmail" }).success).toBe(true);
  });

  it("refuses a plaintext security value and line breaks in the SMTP fields", () => {
    const other = {
      ...base,
      preset: "other",
      host: "imap.example.org",
      smtpHost: "smtp.example.org",
      smtpPort: 25,
      smtpSecurity: "starttls",
    };
    expect(newAccountInputSchema.safeParse({ ...other, smtpSecurity: "none" }).success).toBe(false);
    for (const bad of LINE_BREAKS) {
      expect(newAccountInputSchema.safeParse({ ...other, smtpHost: `smtp${bad}` }).success).toBe(false);
      expect(newAccountInputSchema.safeParse({ ...other, smtpUsername: bad }).success).toBe(false);
    }
  });
});
