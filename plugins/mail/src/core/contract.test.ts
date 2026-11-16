import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  MAIL_CHANGED_CHANNEL,
  NEW_MAIL_CHANNEL,
  OUTBOX_CHANGED_CHANNEL,
  headerAddressInput,
  newMailPayloadSchema,
  rpcSchemas,
} from "./contract.ts";
import {
  accountSchema,
  draftViewSchema,
  identityViewSchema,
  newAccountInputSchema,
  outboxRowSchema,
  outboxStateSchema,
  presendIssueSchema,
  proposalViewSchema,
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

/** The 8 owner-only methods slice 3c adds. */
const SLICE_3C_METHODS = [
  "proposal_view",
  "proposal_status",
  "translate_start",
  "translate_poll",
  "translate_cancel",
  "translate_settings_get",
  "translate_settings_set",
  "translate_clear",
] as const;

/** The 11 owner-only methods slice 3d adds. */
const SLICE_3D_METHODS = [
  "identities_list",
  "identity_add",
  "identity_update",
  "identity_remove",
  "identity_suggestions",
  "identity_dismiss",
  "templates_list",
  "template_save",
  "template_delete",
  "compose_check",
  "action_undo",
] as const;

/** The 14 owner-only methods slice 3e adds. */
const SLICE_3E_METHODS = [
  "new_mail_get",
  "unsubscribe_info",
  "unsubscribe_run",
  "unsubscribe_archive",
  "message_snooze",
  "message_unsnooze",
  "snooze_folder_create",
  "snooze_folder_use",
  "block_add",
  "block_list",
  "block_remove",
  "block_check",
  "triage_view",
  "triage_status",
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
  it("declares exactly the slice-1 methods plus the slice-2, 3a, 3b, 3c, 3d and 3e additions", () => {
    expect(Object.keys(rpcSchemas).sort()).toEqual(
      [
        ...COMPOSE_METHODS,
        ...SLICE_3C_METHODS,
        ...SLICE_3D_METHODS,
        ...SLICE_3E_METHODS,
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
    expect(parse({ groups: [group], undoable: false })).toBe(true);
    expect(parse({ groups: [{ ...group, destination: null, error: "Refused" }], undoable: true })).toBe(true);
    expect(parse({ groups: [{ ...group, queued: -1 }], undoable: false })).toBe(false);
    expect(parse({ groups: [{ ...group, error: undefined }], undoable: false })).toBe(false);
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
    const later: readonly string[] = [...SLICE_3C_METHODS, ...SLICE_3D_METHODS, ...SLICE_3E_METHODS];
    expect(Object.keys(rpcSchemas).filter((m) => !later.includes(m))).toHaveLength(36);
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
      "sender_refused",
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
      origin: "owner",
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
      import: { html: "<p>quoted</p>", into: "quote", stripSignature: false },
      origin: "owner",
      fromAddress: null,
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

describe("slice-3c contract", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) =>
    rpcSchemas[method].input.safeParse(input).success;
  const HASH = "a".repeat(64);

  it("adds exactly 8 methods to the 36 before it", () => {
    expect(SLICE_3C_METHODS).toHaveLength(8);
    const later: readonly string[] = [...SLICE_3D_METHODS, ...SLICE_3E_METHODS];
    expect(Object.keys(rpcSchemas).filter((m) => !later.includes(m))).toHaveLength(44);
    expect(COMPOSE_METHODS).toHaveLength(19);
  });

  it("refuses empty and overlong ids in every new method", () => {
    const idInputs: [keyof typeof rpcSchemas, Record<string, unknown>, string][] = [
      ["proposal_view", { contentHash: HASH }, "proposalId"],
      ["proposal_status", {}, "proposalId"],
      ["translate_start", { targetLanguage: "ru" }, "messageId"],
      ["translate_poll", { from: 0 }, "jobId"],
      ["translate_cancel", {}, "jobId"],
    ];
    for (const [method, rest, key] of idInputs) {
      expect(parses(method, { ...rest, [key]: "x" }), `${method} ${key}`).toBe(true);
      expect(parses(method, { ...rest, [key]: "" })).toBe(false);
      expect(parses(method, { ...rest, [key]: "x".repeat(257) })).toBe(false);
    }
  });

  it("takes a 64-hex content hash in proposal_view", () => {
    expect(parses("proposal_view", { proposalId: "p", contentHash: HASH })).toBe(true);
    for (const bad of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), ""]) {
      expect(parses("proposal_view", { proposalId: "p", contentHash: bad })).toBe(false);
    }
  });

  it("starts a translation with a known language tag, optionally forced", () => {
    expect(parses("translate_start", { messageId: "m", targetLanguage: "ru" })).toBe(true);
    expect(parses("translate_start", { messageId: "m", targetLanguage: "de", force: true })).toBe(true);
    for (const tag of ["xx", "", "RU", "ru-RU"]) {
      expect(parses("translate_start", { messageId: "m", targetLanguage: tag })).toBe(false);
    }
  });

  it("polls from a non-negative integer", () => {
    expect(parses("translate_poll", { jobId: "j", from: 10 })).toBe(true);
    expect(parses("translate_poll", { jobId: "j", from: -1 })).toBe(false);
    expect(parses("translate_poll", { jobId: "j", from: 1.5 })).toBe(false);
  });

  it("sets translation settings: bounded, no line breaks or NUL, a known language", () => {
    const set = (overrides: Record<string, unknown> = {}) => ({
      providerId: "provider-a",
      model: "model-a",
      language: "ru",
      ...overrides,
    });
    expect(parses("translate_settings_set", set())).toBe(true);
    expect(parses("translate_settings_set", set({ providerId: "", model: "" }))).toBe(true);
    expect(parses("translate_settings_set", set({ providerId: "p".repeat(64) }))).toBe(true);
    expect(parses("translate_settings_set", set({ providerId: "p".repeat(65) }))).toBe(false);
    expect(parses("translate_settings_set", set({ model: "m".repeat(200) }))).toBe(true);
    expect(parses("translate_settings_set", set({ model: "m".repeat(201) }))).toBe(false);
    expect(parses("translate_settings_set", set({ language: "xx" }))).toBe(false);
    for (const bad of LINE_BREAKS) {
      expect(parses("translate_settings_set", set({ providerId: bad }))).toBe(false);
      expect(parses("translate_settings_set", set({ model: bad }))).toBe(false);
    }
  });

  it("takes empty inputs for settings_get and clear", () => {
    expect(parses("translate_settings_get", {})).toBe(true);
    expect(parses("translate_clear", {})).toBe(true);
  });

  it("puts no credential-like key in any new output; viewToken only in proposal_view and triage_view", () => {
    for (const method of SLICE_3C_METHODS) {
      const keys = keysOf(rpcSchemas[method].output);
      expect(keys.length, method).toBeGreaterThan(0);
      expect(keys.filter((key) => SECRET_KEY.test(key)), method).toEqual([]);
    }
    for (const [name, method] of Object.entries(rpcSchemas)) {
      const tokens = keysOf(method.output as z.ZodType).filter((key) => /token/i.test(key));
      expect(tokens, name).toEqual(name === "proposal_view" || name === "triage_view" ? ["viewToken"] : []);
    }
  });

  it("shapes a proposal view with flags per recipient", () => {
    const view = {
      proposalId: "p_1",
      draftId: "d_1",
      kind: "reply",
      account: { id: "acc_1", name: "Work", address: "owner@example.org" },
      fromName: "Owner",
      source: { fromAddress: "anna@example.org", subject: "Garden plans" },
      to: [{ address: "anna@example.org", name: "Anna", flags: [] }],
      cc: [],
      bcc: [{ address: "x@example.com", name: null, flags: ["new", "added", "outside", "hidden_chars"] }],
      subject: "Re: Garden plans",
      hiddenChars: 0,
      bodyText: "Invented reply",
      quoteText: "On … wrote:",
      links: [{ url: "example.com", host: "example.com" }],
      attachments: [{ fileName: "plan.txt", mimeType: "text/plain", size: 10 }],
      leftOut: 0,
      expiresAt: "2026-11-16T10:00:00.000Z",
      fromAlias: false,
      signatureText: null,
      templateName: null,
      checks: [],
    };
    const ready = { state: "ready", view, viewToken: "A".repeat(43) };
    expect(rpcSchemas.proposal_view.output.safeParse(ready).success).toBe(true);
    for (const state of ["changed", "gone", "opened_elsewhere"]) {
      expect(rpcSchemas.proposal_view.output.safeParse({ state }).success).toBe(true);
    }
    expect(rpcSchemas.proposal_view.output.safeParse({ state: "other" }).success).toBe(false);
    const badFlag = { ...view, to: [{ address: "a@example.org", name: null, flags: ["trusted"] }] };
    expect(rpcSchemas.proposal_view.output.safeParse({ ...ready, view: badFlag }).success).toBe(false);
    expect(keysOf(rpcSchemas.proposal_view.output)).toEqual(
      expect.arrayContaining(["view", "viewToken", "flags", "links", "hiddenChars", "quoteText", "expiresAt"]),
    );
  });

  it("shapes proposal_status with the proposal states and fixed reasons", () => {
    const status = (overrides: Record<string, unknown>) =>
      rpcSchemas.proposal_status.output.safeParse({ state: "queued", outboxId: "p_1", draftId: null, reason: null, ...overrides })
        .success;
    for (const state of ["pending", "confirming", "queued", "opened", "cancelled", "expired", "refused"]) {
      expect(status({ state })).toBe(true);
    }
    for (const reason of ["rate_limited", "too_large", "account", "changed"]) {
      expect(status({ reason })).toBe(true);
    }
    expect(status({ state: "sent" })).toBe(false);
    expect(status({ reason: "smtp said no" })).toBe(false);
  });

  it("shapes the translation outputs", () => {
    const cached = {
      messageId: "m_1",
      targetLanguage: "ru",
      providerId: "provider-a",
      model: "model-a",
      text: "Invented translation",
      truncated: false,
      cached: true,
      createdAt: "2026-11-15T10:00:00.000Z",
    };
    expect(rpcSchemas.translate_start.output.safeParse({ cached }).success).toBe(true);
    expect(rpcSchemas.translate_start.output.safeParse({ jobId: "j_1" }).success).toBe(true);
    expect(rpcSchemas.translate_poll.output.safeParse({ state: "running", text: "Inv" }).success).toBe(true);
    expect(
      rpcSchemas.translate_poll.output.safeParse({
        state: "done",
        text: "ented",
        finish: "max_tokens",
        truncatedInput: true,
        provider: "provider-a",
        model: "model-a",
      }).success,
    ).toBe(true);
    expect(
      rpcSchemas.translate_poll.output.safeParse({
        state: "failed",
        text: "",
        error: "pool_unavailable",
        gatewayMessage: "Bridge not ready",
      }).success,
    ).toBe(true);
    expect(rpcSchemas.translate_poll.output.safeParse({ state: "failed", text: "", error: "boom" }).success).toBe(false);
    expect(
      rpcSchemas.translate_settings_get.output.safeParse({
        gateway: "ok",
        providers: [{ id: "provider-a", displayName: "Provider A", available: true }],
        models: null,
        current: { providerId: "", model: "", language: "ru" },
      }).success,
    ).toBe(true);
    expect(
      rpcSchemas.translate_settings_get.output.safeParse({
        gateway: "gateway_missing",
        providers: [],
        models: [{ model: "model-a", displayName: "Model A" }],
        current: { providerId: "", model: "", language: "ru" },
      }).success,
    ).toBe(true);
    expect(rpcSchemas.translate_cancel.output.safeParse({ cancelled: true }).success).toBe(true);
    expect(rpcSchemas.translate_settings_set.output.safeParse({ ok: true }).success).toBe(true);
    expect(rpcSchemas.translate_clear.output.safeParse({ removed: 3 }).success).toBe(true);
  });

  it("exports headerAddressInput, which refuses CR, LF and NUL", () => {
    expect(headerAddressInput.safeParse("anna@example.org").success).toBe(true);
    for (const bad of LINE_BREAKS) expect(headerAddressInput.safeParse(bad).success).toBe(false);
    expect(headerAddressInput.safeParse("a@").success).toBe(false);
  });

  it("marks drafts and outbox rows with their origin", () => {
    expect(draftViewSchema.shape.origin.options).toEqual(["owner", "agent"]);
    expect(outboxRowSchema.shape.origin.options).toEqual(["owner", "agent"]);
  });

  it("tells the page whether agent proposals are on and how the translation gateway stands", () => {
    expect(
      statusViewSchema.safeParse({
        vaultReady: true,
        agentTools: false,
        agentPropose: false,
        translate: { gateway: "ok" },
        accounts: [],
        unreadCount: 0,
      }).success,
    ).toBe(true);
    expect(keysOf(rpcSchemas.status_get.output)).toEqual(expect.arrayContaining(["agentPropose", "translate", "gateway"]));
  });
});

describe("slice-3d contract", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) =>
    rpcSchemas[method].input.safeParse(input).success;
  const outputs = (method: keyof typeof rpcSchemas, output: unknown) =>
    rpcSchemas[method].output.safeParse(output).success;
  const UUID = "6f1c2a52-3b5e-4f0a-9c1d-2e7b8a9c0d1e";
  const DOC = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Invented" }] }] };
  const identity = {
    accountId: "acc_1",
    address: "alias@example.org",
    displayName: "Owner",
    primary: false,
    signature: null,
    sendCheck: "pending",
  };

  it("adds exactly 11 methods to the 44 before it", () => {
    expect(SLICE_3D_METHODS).toHaveLength(11);
    expect(Object.keys(rpcSchemas).filter((m) => !(SLICE_3E_METHODS as readonly string[]).includes(m))).toHaveLength(55);
    expect(COMPOSE_METHODS).toHaveLength(19);
    expect(SLICE_3C_METHODS).toHaveLength(8);
  });

  it("refuses empty and overlong ids in every new method", () => {
    const address = "alias@example.org";
    const idInputs: [keyof typeof rpcSchemas, Record<string, unknown>, string][] = [
      ["identities_list", {}, "accountId"],
      ["identity_add", { address }, "accountId"],
      ["identity_update", { address }, "accountId"],
      ["identity_remove", { address }, "accountId"],
      ["identity_suggestions", {}, "accountId"],
      ["identity_dismiss", { address }, "accountId"],
      ["template_save", { name: "Thanks", doc: DOC }, "id"],
      ["template_delete", {}, "id"],
      ["compose_check", { baseRevision: 1 }, "draftId"],
    ];
    for (const [method, rest, key] of idInputs) {
      expect(parses(method, { ...rest, [key]: "x" }), `${method} ${key}`).toBe(true);
      expect(parses(method, { ...rest, [key]: "" }), `${method} ${key}`).toBe(false);
      expect(parses(method, { ...rest, [key]: "x".repeat(257) }), `${method} ${key}`).toBe(false);
    }
    expect(parses("identities_list", { accountId: null })).toBe(true);
    expect(parses("template_save", { name: "Thanks", doc: DOC })).toBe(true);
    expect(parses("templates_list", {})).toBe(true);
  });

  it("takes a required uuid undoId on action_undo and an optional one on message_action", () => {
    expect(parses("action_undo", { undoId: UUID })).toBe(true);
    expect(parses("action_undo", {})).toBe(false);
    expect(parses("action_undo", { undoId: "not-a-uuid" })).toBe(false);
    const action = { messageIds: ["m"], folder: "INBOX", action: "archive" };
    expect(parses("message_action", action)).toBe(true);
    expect(parses("message_action", { ...action, undoId: UUID })).toBe(true);
    expect(parses("message_action", { ...action, undoId: "x" })).toBe(false);
    expect(outputs("message_action", { groups: [], undoable: true })).toBe(true);
    expect(outputs("message_action", { groups: [] })).toBe(false);
  });

  it("refuses CR, LF and NUL in every new address and in compose_save's fromAddress", () => {
    const save = {
      draftId: "d_1",
      baseRevision: 3,
      accountId: "acc_1",
      to: [],
      cc: [],
      bcc: [],
      subject: "Invented",
      doc: DOC,
    };
    expect(parses("compose_save", save)).toBe(true);
    expect(parses("compose_save", { ...save, fromAddress: null })).toBe(true);
    expect(parses("compose_save", { ...save, fromAddress: "alias@example.org" })).toBe(true);
    for (const method of ["identity_add", "identity_update", "identity_remove", "identity_dismiss"] as const) {
      expect(parses(method, { accountId: "a", address: "alias@example.org" }), method).toBe(true);
      expect(parses(method, { accountId: "a", address: "a@" }), method).toBe(false);
    }
    for (const bad of LINE_BREAKS) {
      expect(parses("compose_save", { ...save, fromAddress: `${bad}@example.org` })).toBe(false);
      for (const method of ["identity_add", "identity_update", "identity_remove", "identity_dismiss"] as const) {
        expect(parses(method, { accountId: "a", address: `${bad}@example.org` }), method).toBe(false);
      }
    }
  });

  it("bounds display names to one line of 200 characters and template names to one line of 80", () => {
    const add = (displayName: unknown) => parses("identity_add", { accountId: "a", address: "x@example.org", displayName });
    expect(add("Owner")).toBe(true);
    expect(add("n".repeat(200))).toBe(true);
    expect(add("n".repeat(201))).toBe(false);
    const update = (patch: Record<string, unknown>) =>
      parses("identity_update", { accountId: "a", address: "x@example.org", ...patch });
    expect(update({ displayName: null })).toBe(true);
    expect(update({ displayName: "n".repeat(201) })).toBe(false);
    expect(update({ signature: DOC })).toBe(true);
    expect(update({ signature: null })).toBe(true);
    const name = (value: string) => parses("template_save", { name: value, doc: DOC });
    expect(name("t".repeat(80))).toBe(true);
    expect(name("t".repeat(81))).toBe(false);
    expect(name("")).toBe(false);
    for (const bad of LINE_BREAKS) {
      expect(add(bad)).toBe(false);
      expect(update({ displayName: bad })).toBe(false);
      expect(name(bad)).toBe(false);
    }
  });

  it("shapes the identity, template, check and undo outputs", () => {
    expect(outputs("identities_list", { identities: [identity] })).toBe(true);
    expect(outputs("identity_add", { ...identity, signature: DOC })).toBe(true);
    expect(outputs("identity_add", { ...identity, sendCheck: "maybe" })).toBe(false);
    expect(outputs("identity_remove", { ok: true })).toBe(true);
    expect(
      outputs("identity_suggestions", {
        suggestions: [{ address: "other@example.org", count: 3, lastDate: "2026-11-15T10:00:00.000Z" }],
      }),
    ).toBe(true);
    expect(
      outputs("templates_list", {
        templates: [{ id: "t_1", name: "Thanks", doc: DOC, updatedAt: "2026-11-15T10:00:00.000Z" }],
      }),
    ).toBe(true);
    expect(outputs("template_save", { id: "t_1" })).toBe(true);
    expect(outputs("compose_check", { issues: [{ kind: "empty_subject" }] })).toBe(true);
    const undo = {
      outcome: "done",
      restored: 2,
      skipped: [{ reason: "moved_elsewhere", count: 1 }],
      failed: 0,
      groups: [{ accountId: "acc_1", folder: "INBOX", queued: 2, destination: null, error: null }],
    };
    expect(outputs("action_undo", undo)).toBe(true);
    expect(outputs("action_undo", { ...undo, outcome: "maybe" })).toBe(false);
    expect(outputs("action_undo", { ...undo, skipped: [{ reason: "lost", count: 1 }] })).toBe(false);
    for (const reason of ["moved_elsewhere", "gone", "folder_gone", "not_synced"]) {
      expect(outputs("action_undo", { ...undo, skipped: [{ reason, count: 1 }] })).toBe(true);
    }
  });

  it("round-trips each pre-send issue kind", () => {
    const issues = [
      { kind: "attachment_mentioned", phrase: "attached" },
      { kind: "empty_subject" },
      { kind: "outside_conversation", addresses: ["x@example.org"] },
      { kind: "new_recipients", addresses: ["y@example.org"] },
    ];
    for (const issue of issues) expect(presendIssueSchema.parse(issue)).toEqual(issue);
    expect(presendIssueSchema.safeParse({ kind: "attachment_mentioned" }).success).toBe(false);
    expect(presendIssueSchema.safeParse({ kind: "other" }).success).toBe(false);
  });

  it("parses sender_refused in an outbox row", () => {
    const row = {
      id: UUID,
      accountId: "acc_1",
      subject: "Invented",
      state: "failed",
      errorKind: "sender_refused",
      rejected: [],
      sendAfter: "2026-11-15T10:00:10.000Z",
      attempts: 1,
      origin: "owner",
    };
    expect(outboxRowSchema.safeParse(row).success).toBe(true);
  });

  it("adds fromAddress and stripSignature to the draft view, and the card's 3d fields", () => {
    expect(Object.keys(draftViewSchema.shape)).toContain("fromAddress");
    expect(keysOf(draftViewSchema)).toContain("stripSignature");
    expect(keysOf(identityViewSchema)).toEqual(
      expect.arrayContaining(["accountId", "address", "displayName", "primary", "signature", "sendCheck"]),
    );
    expect(Object.keys(proposalViewSchema.shape)).toEqual(
      expect.arrayContaining(["fromAlias", "signatureText", "templateName", "checks"]),
    );
  });

  it("puts no credential-like key in any new output", () => {
    for (const method of SLICE_3D_METHODS) {
      const keys = keysOf(rpcSchemas[method].output);
      expect(keys.length, method).toBeGreaterThan(0);
      expect(keys.filter((key) => SECRET_KEY.test(key)), method).toEqual([]);
    }
  });
});

describe("slice-3e contract", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) =>
    rpcSchemas[method].input.safeParse(input).success;
  const outputs = (method: keyof typeof rpcSchemas, output: unknown) =>
    rpcSchemas[method].output.safeParse(output).success;
  const UUID = "8f14e45f-ceea-467a-9575-6ab4a1b2c3d4";
  const HASH = "a".repeat(64);
  const UNTIL = "2026-11-16T08:00:00.000Z";

  it("adds exactly 14 methods to the 55 before it", () => {
    expect(SLICE_3E_METHODS).toHaveLength(14);
    expect(Object.keys(rpcSchemas)).toHaveLength(69);
    expect(COMPOSE_METHODS).toHaveLength(19);
    expect(SLICE_3C_METHODS).toHaveLength(8);
    expect(SLICE_3D_METHODS).toHaveLength(11);
  });

  it("refuses empty and overlong ids in every new method", () => {
    const idInputs: [keyof typeof rpcSchemas, Record<string, unknown>, string][] = [
      ["unsubscribe_info", {}, "messageId"],
      ["unsubscribe_run", { method: "mailto", requestId: UUID }, "messageId"],
      ["unsubscribe_archive", {}, "messageId"],
      ["message_snooze", { messageIds: ["m"], until: UNTIL }, "folder"],
      ["snooze_folder_create", {}, "accountId"],
      ["snooze_folder_use", { path: "Snoozed" }, "accountId"],
      ["snooze_folder_use", { accountId: "a" }, "path"],
      ["block_add", { kind: "address", moveExisting: false }, "messageId"],
      ["block_remove", {}, "id"],
      ["block_check", {}, "messageId"],
      ["triage_view", { contentHash: HASH }, "batchId"],
      ["triage_status", {}, "batchId"],
    ];
    for (const [method, rest, key] of idInputs) {
      expect(parses(method, { ...rest, [key]: "x" }), `${method} ${key}`).toBe(true);
      expect(parses(method, { ...rest, [key]: "" }), `${method} ${key}`).toBe(false);
      expect(parses(method, { ...rest, [key]: "x".repeat(257) }), `${method} ${key}`).toBe(false);
    }
    for (const method of ["message_snooze", "message_unsnooze"] as const) {
      const rest = method === "message_snooze" ? { folder: "INBOX", until: UNTIL } : {};
      expect(parses(method, { ...rest, messageIds: ["m"] }), method).toBe(true);
      expect(parses(method, { ...rest, messageIds: [""] }), method).toBe(false);
      expect(parses(method, { ...rest, messageIds: ["x".repeat(257)] }), method).toBe(false);
    }
  });

  it("bounds the message lists at 200 and refuses an empty one", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
    expect(parses("message_snooze", { messageIds: ids(200), folder: "INBOX", until: UNTIL })).toBe(true);
    expect(parses("message_snooze", { messageIds: ids(201), folder: "INBOX", until: UNTIL })).toBe(false);
    expect(parses("message_snooze", { messageIds: [], folder: "INBOX", until: UNTIL })).toBe(false);
    expect(parses("message_unsnooze", { messageIds: ids(200) })).toBe(true);
    expect(parses("message_unsnooze", { messageIds: ids(201) })).toBe(false);
    expect(parses("message_unsnooze", { messageIds: [] })).toBe(false);
  });

  it("takes exactly one of folder and role and an ISO until on message_snooze", () => {
    const base = { messageIds: ["m"], until: UNTIL };
    expect(parses("message_snooze", { ...base, role: "inbox" })).toBe(true);
    expect(parses("message_snooze", { ...base, folder: "INBOX", undoId: UUID })).toBe(true);
    expect(parses("message_snooze", { ...base, folder: "INBOX", role: "inbox" })).toBe(false);
    expect(parses("message_snooze", base)).toBe(false);
    expect(parses("message_snooze", { ...base, folder: "INBOX", undoId: "x" })).toBe(false);
    for (const until of ["tomorrow", "2026-11-16", "2026-11-16 08:00", "", "1763280000000"]) {
      expect(parses("message_snooze", { ...base, folder: "INBOX", until }), until).toBe(false);
    }
  });

  it("requires a uuid requestId and a known method on unsubscribe_run", () => {
    const run = { messageId: "m", method: "one_click", requestId: UUID };
    expect(parses("unsubscribe_run", run)).toBe(true);
    expect(parses("unsubscribe_run", { ...run, requestId: "not-a-uuid" })).toBe(false);
    expect(parses("unsubscribe_run", { messageId: "m", method: "one_click" })).toBe(false);
    expect(parses("unsubscribe_run", { ...run, method: "https" })).toBe(false);
  });

  it("bounds the new-mail token at 64 characters", () => {
    expect(parses("new_mail_get", { token: "t".repeat(64) })).toBe(true);
    expect(parses("new_mail_get", { token: "t".repeat(65) })).toBe(false);
    expect(parses("new_mail_get", { token: "" })).toBe(false);
    expect(outputs("new_mail_get", { items: [], more: 0 })).toBe(true);
    const item = { accountId: "a", threadId: "t", messageId: "m", name: "Ada", address: "ada@example.org" };
    expect(outputs("new_mail_get", { items: [item, item, item], more: 2 })).toBe(true);
    expect(outputs("new_mail_get", { items: [item, item, item, item], more: 0 })).toBe(false);
  });

  it("takes block kinds address and domain, a boolean moveExisting and an optional uuid undoId", () => {
    const add = { messageId: "m", kind: "address", moveExisting: true };
    expect(parses("block_add", add)).toBe(true);
    expect(parses("block_add", { ...add, kind: "domain", undoId: UUID })).toBe(true);
    expect(parses("block_add", { ...add, kind: "everyone" })).toBe(false);
    expect(parses("block_add", { ...add, moveExisting: "yes" })).toBe(false);
    expect(parses("block_add", { ...add, undoId: "x" })).toBe(false);
    expect(parses("block_list", {})).toBe(true);
    expect(
      outputs("block_check", {
        address: "news@example.com",
        domain: null,
        sentToCount: 0,
        storedCount: { address: 3, domain: null },
      }),
    ).toBe(true);
  });

  it("checks the triage content hash shape", () => {
    expect(parses("triage_view", { batchId: "b", contentHash: HASH })).toBe(true);
    expect(parses("triage_view", { batchId: "b", contentHash: "A".repeat(64) })).toBe(false);
    expect(parses("triage_view", { batchId: "b", contentHash: "a".repeat(63) })).toBe(false);
    expect(outputs("triage_view", { state: "changed" })).toBe(true);
    expect(outputs("triage_view", { state: "gone" })).toBe(true);
    expect(outputs("triage_view", { state: "pending" })).toBe(false);
  });

  it("filters threads_list by true flags only, plus the open thread", () => {
    const list = { scope: { kind: "account", accountId: "a", folder: "INBOX" }, cursor: null, limit: 50 };
    expect(parses("threads_list", list)).toBe(true);
    expect(parses("threads_list", { ...list, filter: {} })).toBe(true);
    expect(parses("threads_list", { ...list, filter: { unread: true, flagged: true, attachments: true } })).toBe(true);
    expect(parses("threads_list", { ...list, filter: { unread: true, keep: "t_1" } })).toBe(true);
    for (const flag of ["unread", "flagged", "attachments"]) {
      expect(parses("threads_list", { ...list, filter: { [flag]: false } }), flag).toBe(false);
      expect(parses("threads_list", { ...list, filter: { [flag]: "true" } }), flag).toBe(false);
    }
    expect(parses("threads_list", { ...list, filter: { keep: "" } })).toBe(false);
    expect(parses("threads_list", { ...list, filter: { keep: "x".repeat(257) } })).toBe(false);
    expect(Object.keys(threadSummarySchema.shape)).toContain("snoozedUntil");
  });

  it("puts no credential-like key in any new output, and no list key in unsubscribe_info", () => {
    for (const method of SLICE_3E_METHODS) {
      const keys = keysOf(rpcSchemas[method].output);
      expect(keys.length, method).toBeGreaterThan(0);
      expect(keys.filter((key) => SECRET_KEY.test(key)), method).toEqual([]);
    }
    expect(keysOf(rpcSchemas.unsubscribe_info.output)).not.toContain("listKey");
    expect(keysOf(rpcSchemas.triage_view.output)).toEqual(expect.arrayContaining(["viewToken", "available", "note"]));
  });

  it("publishes mail-new with a token and nothing else", () => {
    expect(NEW_MAIL_CHANNEL).toBe("mail-new");
    expect(newMailPayloadSchema.safeParse({ token: "abc" }).success).toBe(true);
    expect(newMailPayloadSchema.safeParse({ token: "abc", accountId: "a" }).success).toBe(false);
    expect(newMailPayloadSchema.safeParse({ token: "t".repeat(65) }).success).toBe(false);
    expect(newMailPayloadSchema.safeParse({}).success).toBe(false);
  });
});
