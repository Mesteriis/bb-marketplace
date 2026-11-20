import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { AI_KINDS } from "./ai-input.ts";
import {
  AI_START_KINDS,
  BB_REFUSAL_TEXT,
  DAY_NOTICE_CHANNEL,
  MAIL_CHANGED_CHANNEL,
  NEW_MAIL_CHANNEL,
  dayNoticePayloadSchema,
  OUTBOX_CHANGED_CHANNEL,
  headerAddressInput,
  newMailPayloadSchema,
  rpcSchemas,
  SLICE_3H_METHODS,
  SLICE_3I_METHODS,
  SLICE_3K_METHODS,
  SLICE_3L_METHODS,
  SLICE_3M_METHODS,
  SLICE_3N_METHODS,
  SLICE_3P_METHODS,
  SIGN_IN_METHODS,
  GOOGLE_METHODS,
  SETTINGS_METHODS,
  PLUGIN_METHODS,
  INBOX_TAB_METHODS,
  TYPING_METHODS,
  AI_WRITE_METHODS,
  AI_SORT_METHODS,
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
  messageBodySchema,
  threadDetailSchema,
  taskViewSchema,
  composeAttachmentSchema,
  specialUseSchema,
  statusViewSchema,
  threadSummarySchema,
  mailCryptoSchema,
  senderCheckViewSchema,
} from "./model.ts";
import { CRYPTO_KINDS } from "./mail-crypto.ts";
import { SENDER_CHECK_STATES } from "./sender-check.ts";
import { DISGUISE_WARNING_KINDS } from "./sender-disguise.ts";

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

/** The 24 owner-only methods slice 3f adds. */
const SLICE_3F_METHODS = [
  "ai_start",
  "ai_poll",
  "ai_cancel",
  "tasks_keep",
  "tasks_list",
  "task_update",
  "task_delete",
  "category_set",
  "category_accept",
  "category_undo",
  "category_rule_add",
  "category_rule_remove",
  "category_rules_list",
  "today_get",
  "reply_dismiss",
  "reminder_set",
  "reminder_snooze",
  "reminder_dismiss",
  "reminders_due",
  "day_notice_get",
  "ai_scope_get",
  "ai_scope_set",
  "agent_log_list",
  "agent_log_clear",
] as const;

/** The 31 owner-only methods slice 3g adds. */
const SLICE_3G_METHODS = [
  "projects_list",
  "bb_thread_prepare",
  "bb_thread_start",
  "task_targets",
  "task_from_mail",
  "attachment_save",
  "project_files",
  "project_folders",
  "thread_files",
  "bb_threads_recent",
  "compose_attach_bb",
  "draft_from_bb",
  "dev_digest_get",
  "patch_view",
  "patch_save",
  "patch_handoff",
  "patch_handoff_prepare",
  "alert_view",
  "incident_start",
  "incident_prepare",
  "incident_append",
  "conversation_project_set",
  "binding_add",
  "binding_remove",
  "bindings_list",
  "project_mail",
  "bb_thread_mail",
  "rules_list",
  "rule_save",
  "rule_delete",
  "rules_pause",
  "rule_runs_list",
  "rule_run_dismiss",
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
  if (def.type === "nullable" || def.type === "optional" || def.type === "default") {
    return keysOf(def.innerType as z.ZodType);
  }
  if (def.type === "tuple") return (def.items as z.ZodType[]).flatMap(keysOf);
  if (def.type === "union") return (def.options as z.ZodType[]).flatMap(keysOf);
  return [];
}

describe("rpcSchemas", () => {
  it("declares exactly the slice-1 methods plus the slice-2, 3a, 3b, 3c, 3d, 3e, 3f and 3g additions", () => {
    expect(Object.keys(rpcSchemas).sort()).toEqual(
      [
        ...COMPOSE_METHODS,
        ...SLICE_3G_METHODS,
        ...SLICE_3C_METHODS,
        ...SLICE_3D_METHODS,
        ...SLICE_3E_METHODS,
        ...SLICE_3F_METHODS,
        ...SLICE_3H_METHODS,
        ...SLICE_3I_METHODS,
        ...SLICE_3K_METHODS, ...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS,
        "status_get",
        "accounts_test",
        "accounts_add",
        "accounts_remove",
        ...SIGN_IN_METHODS,
        ...GOOGLE_METHODS,
        ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS,
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
      rpcSchemas.message_body.output.safeParse({ ...body, remoteImagesAllowed: true, codeBlocks: [] }).success,
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
      subscribed: true,
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
    const later: readonly string[] = [...SLICE_3C_METHODS, ...SLICE_3D_METHODS, ...SLICE_3E_METHODS, ...SLICE_3F_METHODS, ...SLICE_3G_METHODS, ...SLICE_3H_METHODS, ...SLICE_3I_METHODS, ...SLICE_3K_METHODS, ...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS];
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
      "waiting",
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
      "no_smtp",
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
      attachments: [{ id: "a_1", fileName: "plan.pdf", mimeType: "application/pdf", size: 1200, origin: null }],
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
    const later: readonly string[] = [...SLICE_3D_METHODS, ...SLICE_3E_METHODS, ...SLICE_3F_METHODS, ...SLICE_3G_METHODS, ...SLICE_3H_METHODS, ...SLICE_3I_METHODS, ...SLICE_3K_METHODS, ...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS];
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
      // One method hands out a token on purpose: a Google key narrowed to one service, to a plugin the owner granted.
      const allowed = name === "proposal_view" || name === "triage_view" ? ["viewToken"] : name === "plugin_google_token" ? ["accessToken"] : [];
      expect(tokens, name).toEqual(allowed);
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
        providers: [
          { id: "provider-a", displayName: "Provider A", available: true, reason: null },
          { id: "provider-b", displayName: "Provider B", available: false, reason: "bridge_missing" },
        ],
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
    expect(
      rpcSchemas.translate_settings_get.output.safeParse({
        gateway: "ok",
        providers: [{ id: "provider-a", displayName: "Provider A", available: false, reason: "r".repeat(201) }],
        models: null,
        current: { providerId: "", model: "", language: "ru" },
      }).success,
    ).toBe(false);
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
    const later: readonly string[] = [...SLICE_3E_METHODS, ...SLICE_3F_METHODS, ...SLICE_3G_METHODS, ...SLICE_3H_METHODS, ...SLICE_3I_METHODS, ...SLICE_3K_METHODS, ...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS];
    expect(Object.keys(rpcSchemas).filter((m) => !later.includes(m))).toHaveLength(55);
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
        templates: [
          {
            id: "t_1",
            name: "Thanks",
            doc: DOC,
            updatedAt: "2026-11-15T10:00:00.000Z",
            subject: null,
            to: ["ada@example.com"],
            cc: [],
            bcc: [],
            files: [{ id: "f_1", name: "a.pdf", mimeType: "application/pdf", size: 3 }],
          },
        ],
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
    const later: readonly string[] = [...SLICE_3F_METHODS, ...SLICE_3G_METHODS, ...SLICE_3H_METHODS, ...SLICE_3I_METHODS, ...SLICE_3K_METHODS, ...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS];
    expect(Object.keys(rpcSchemas).filter((m) => !later.includes(m))).toHaveLength(69);
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

describe("slice-3f contract", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) =>
    rpcSchemas[method].input.safeParse(input).success;
  const outputs = (method: keyof typeof rpcSchemas, output: unknown) =>
    rpcSchemas[method].output.safeParse(output).success;
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
  const draft = { kind: "draft", draftId: "d", revision: 3, mode: "fix", paragraphs: ["Hello"] };

  it("adds exactly 24 methods to the 69 before it", () => {
    expect(SLICE_3F_METHODS).toHaveLength(24);
    const later: readonly string[] = [...SLICE_3G_METHODS, ...SLICE_3H_METHODS, ...SLICE_3I_METHODS, ...SLICE_3K_METHODS, ...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS];
    expect(Object.keys(rpcSchemas).filter((m) => !later.includes(m))).toHaveLength(93);
    expect(COMPOSE_METHODS).toHaveLength(19);
    expect(SLICE_3C_METHODS).toHaveLength(8);
    expect(SLICE_3D_METHODS).toHaveLength(11);
    expect(SLICE_3E_METHODS).toHaveLength(14);
  });

  it("offers every AI kind through ai_start", () => {
    // An auto draft is started by new mail, never by a call.
    expect([...AI_START_KINDS].sort()).toEqual(["ask", "categories", "digest", "draft", "summary", "tasks", "write"]);
    expect(AI_KINDS.filter((kind) => !AI_START_KINDS.includes(kind))).toEqual(["autodraft", "sort"]);
    const write = { kind: "write", draftId: "d", revision: 1, instruction: "say yes", paragraphs: [] };
    expect(parses("ai_start", write)).toBe(true);
    expect(parses("ai_start", { ...write, instruction: "" })).toBe(false);
    expect(parses("ai_start", { ...write, instruction: "x".repeat(501) })).toBe(false);
    expect(parses("ai_start", { ...write, instruction: "two\nlines" })).toBe(false);
    expect(parses("ai_start", { ...write, kind: "autodraft" })).toBe(false);
  });

  it("takes each ai_start variant and refuses unknown kinds and extra keys", () => {
    expect(parses("ai_start", { kind: "summary", threadId: "t" })).toBe(true);
    expect(parses("ai_start", { kind: "summary", threadId: "t", folder: "INBOX", force: true })).toBe(true);
    expect(parses("ai_start", { kind: "tasks", messageId: "m" })).toBe(true);
    expect(parses("ai_start", { kind: "tasks", threadId: "t", folder: "INBOX" })).toBe(true);
    expect(parses("ai_start", { kind: "tasks", messageId: "m", threadId: "t" })).toBe(false);
    expect(parses("ai_start", { kind: "ask", question: "When is the meeting?" })).toBe(true);
    expect(parses("ai_start", { kind: "categories", messageIds: ["m"] })).toBe(true);
    expect(parses("ai_start", { kind: "digest" })).toBe(true);
    expect(parses("ai_start", draft)).toBe(true);
    expect(parses("ai_start", { kind: "translate", messageId: "m" })).toBe(false);
    expect(parses("ai_start", { kind: "digest", accountId: "a" })).toBe(false);
    expect(parses("ai_start", { kind: "summary" })).toBe(false);
  });

  it("refuses empty and overlong ids in ai_start", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "summary" }, "threadId"],
      [{ kind: "tasks" }, "messageId"],
      [{ kind: "ask", question: "q" }, "accountId"],
      [{ ...draft }, "draftId"],
    ];
    for (const [rest, key] of cases) {
      expect(parses("ai_start", { ...rest, [key]: "x" }), key).toBe(true);
      expect(parses("ai_start", { ...rest, [key]: "" }), key).toBe(false);
      expect(parses("ai_start", { ...rest, [key]: "x".repeat(257) }), key).toBe(false);
    }
  });

  it("bounds the question, the message list, paragraphs and the instruction", () => {
    expect(parses("ai_start", { kind: "ask", question: "q".repeat(500) })).toBe(true);
    expect(parses("ai_start", { kind: "ask", question: "q".repeat(501) })).toBe(false);
    expect(parses("ai_start", { kind: "ask", question: "" })).toBe(false);
    expect(parses("ai_start", { kind: "categories", messageIds: ids(50) })).toBe(true);
    expect(parses("ai_start", { kind: "categories", messageIds: ids(51) })).toBe(false);
    expect(parses("ai_start", { kind: "categories", messageIds: [] })).toBe(false);
    expect(parses("ai_start", { ...draft, paragraphs: ids(500) })).toBe(true);
    expect(parses("ai_start", { ...draft, paragraphs: ids(501) })).toBe(false);
    expect(parses("ai_start", { ...draft, mode: "custom", instruction: "i".repeat(200) })).toBe(true);
    expect(parses("ai_start", { ...draft, mode: "custom", instruction: "i".repeat(201) })).toBe(false);
    expect(parses("ai_start", { ...draft, mode: "custom", instruction: "first\nsecond" })).toBe(false);
    expect(parses("ai_start", { ...draft, mode: "poem" })).toBe(false);
  });

  it("bounds task picks, titles and due dates", () => {
    const pick = { index: 0, title: "Send the report", due: "2026-11-20" };
    expect(parses("tasks_keep", { jobId: "j", picks: [pick] })).toBe(true);
    expect(parses("tasks_keep", { jobId: "j", picks: [{ ...pick, due: null }] })).toBe(true);
    expect(parses("tasks_keep", { jobId: "j", picks: Array.from({ length: 20 }, (_, i) => ({ ...pick, index: i })) })).toBe(true);
    expect(parses("tasks_keep", { jobId: "j", picks: Array.from({ length: 21 }, (_, i) => ({ ...pick, index: i % 20 })) })).toBe(false);
    expect(parses("tasks_keep", { jobId: "j", picks: [] })).toBe(false);
    expect(parses("tasks_keep", { jobId: "j", picks: [{ ...pick, title: "t".repeat(120) }] })).toBe(true);
    expect(parses("tasks_keep", { jobId: "j", picks: [{ ...pick, title: "t".repeat(121) }] })).toBe(false);
    expect(parses("tasks_keep", { jobId: "j", picks: [{ ...pick, title: "a\nb" }] })).toBe(false);
    expect(parses("tasks_keep", { jobId: "j", picks: [{ ...pick, title: "" }] })).toBe(false);
    for (const due of ["20.11.2026", "2026-11-20T00:00:00Z", "tomorrow", ""]) {
      expect(parses("tasks_keep", { jobId: "j", picks: [{ ...pick, due }] }), due).toBe(false);
      expect(parses("task_update", { id: "t", due }), due).toBe(false);
    }
    expect(parses("task_update", { id: "t", title: "New", due: null, done: true })).toBe(true);
    expect(parses("task_update", { id: "t", title: "a\rb" })).toBe(false);
  });

  it("bounds category message lists at 200 and takes the four categories", () => {
    expect(parses("category_set", { messageIds: ids(200), category: "bills" })).toBe(true);
    expect(parses("category_set", { messageIds: ids(201), category: "bills" })).toBe(false);
    expect(parses("category_set", { messageIds: ["m"], category: null })).toBe(true);
    expect(parses("category_set", { messageIds: ["m"], category: "spam" })).toBe(false);
    expect(parses("category_accept", { messageIds: ids(200) })).toBe(true);
    expect(parses("category_accept", { messageIds: ids(201) })).toBe(false);
    expect(parses("category_accept", { messageIds: [] })).toBe(false);
    expect(parses("category_rule_add", { messageId: "m", kind: "domain", category: "newsletters" })).toBe(true);
    expect(parses("category_rule_add", { messageId: "m", kind: "everyone", category: "newsletters" })).toBe(false);
  });

  it("takes reminder days 1 to 30, also on compose_send", () => {
    for (const days of [1, 30]) {
      expect(parses("reminder_set", { messageId: "m", days }), String(days)).toBe(true);
      expect(parses("reminder_snooze", { id: "r", days }), String(days)).toBe(true);
    }
    for (const days of [0, 31, 2.5]) {
      expect(parses("reminder_set", { messageId: "m", days }), String(days)).toBe(false);
      expect(parses("reminder_snooze", { id: "r", days }), String(days)).toBe(false);
    }
    const send = { draftId: "d", baseRevision: 1, requestId: "8f14e45f-ceea-467a-9575-6ab4a1b2c3d4" };
    expect(parses("compose_send", send)).toBe(true);
    expect(parses("compose_send", { ...send, remindAfterDays: 3 })).toBe(true);
    expect(parses("compose_send", { ...send, remindAfterDays: 0 })).toBe(false);
    expect(parses("compose_send", { ...send, remindAfterDays: 31 })).toBe(false);
  });

  it("takes an optional day-notice token of at most 64 characters", () => {
    expect(parses("day_notice_get", {})).toBe(true);
    expect(parses("day_notice_get", { token: "t".repeat(64) })).toBe(true);
    expect(parses("day_notice_get", { token: "t".repeat(65) })).toBe(false);
    expect(parses("day_notice_get", { token: "" })).toBe(false);
    expect(outputs("day_notice_get", { kind: "digest", replyCount: 2 })).toBe(true);
    expect(
      outputs("day_notice_get", { kind: "reminder", name: "Ada", address: "ada@example.org", accountId: "a", threadId: null }),
    ).toBe(true);
  });

  it("bounds the scope senders at 1 000 and the log page at 100", () => {
    const sender = (i: number) => ({ kind: "address", value: `s${i}@example.org` });
    const senders = (n: number) => Array.from({ length: n }, (_, i) => sender(i));
    expect(parses("ai_scope_set", { accounts: [{ accountId: "a", mode: "folders", folders: ["INBOX"] }], senders: senders(1_000) })).toBe(true);
    expect(parses("ai_scope_set", { accounts: [], senders: senders(1_001) })).toBe(false);
    expect(parses("ai_scope_set", { accounts: [{ accountId: "a", mode: "some" }], senders: [] })).toBe(false);
    expect(parses("ai_scope_set", { accounts: [], senders: [{ kind: "address", value: "a@example.org\r\nBcc: x" }] })).toBe(false);
    expect(parses("agent_log_list", { limit: 100 })).toBe(true);
    expect(parses("agent_log_list", { limit: 101 })).toBe(false);
    expect(parses("agent_log_list", { limit: 0 })).toBe(false);
    expect(parses("agent_log_list", { threadId: "t", cursor: "12", limit: 20 })).toBe(true);
  });

  it("filters threads_list by category", () => {
    const list = { scope: { kind: "account", accountId: "a", folder: "INBOX" }, cursor: null, limit: 50 };
    expect(parses("threads_list", { ...list, filter: { category: "bills" } })).toBe(true);
    expect(parses("threads_list", { ...list, filter: { category: "spam" } })).toBe(false);
    expect(Object.keys(threadSummarySchema.shape)).toEqual(expect.arrayContaining(["category", "categorySuggestion"]));
    expect(Object.keys(messageHeaderSchema.shape)).toEqual(expect.arrayContaining(["agentSubject", "inAiScope"]));
  });

  it("puts no credential-like key in any new output", () => {
    for (const method of SLICE_3F_METHODS) {
      const keys = keysOf(rpcSchemas[method].output);
      expect(keys.length, method).toBeGreaterThan(0);
      expect(keys.filter((key) => SECRET_KEY.test(key)), method).toEqual([]);
    }
  });

  it("publishes mail-day with a token and nothing else", () => {
    expect(DAY_NOTICE_CHANNEL).toBe("mail-day");
    expect(dayNoticePayloadSchema.safeParse({ token: "abc" }).success).toBe(true);
    expect(dayNoticePayloadSchema.safeParse({ token: "abc", kind: "digest" }).success).toBe(false);
    expect(dayNoticePayloadSchema.safeParse({ token: "t".repeat(65) }).success).toBe(false);
    expect(dayNoticePayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe("slice-3g contract", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) =>
    rpcSchemas[method].input.safeParse(input).success;
  const outputs = (method: keyof typeof rpcSchemas, output: unknown) =>
    rpcSchemas[method].output.safeParse(output).success;
  const SHA = "c".repeat(64);
  const rule = (overrides: Record<string, unknown> = {}) => ({
    name: "CI failures",
    enabled: true,
    match: { dev: { source: "github", kind: "ci", state: "failed" } },
    projectId: "p1",
    template: "Find the failing test.",
    mode: "prepare",
    ...overrides,
  });

  it("adds exactly 33 methods to the 93 before it, leaving the earlier lists alone", () => {
    // 31 at the build, then incident_prepare and patch_handoff_prepare (review C5).
    expect(SLICE_3G_METHODS).toHaveLength(33);
    expect(
      Object.keys(rpcSchemas).filter((m) => !([...SLICE_3H_METHODS, ...SLICE_3I_METHODS, ...SLICE_3K_METHODS, ...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m)),
    ).toHaveLength(126);
    expect(COMPOSE_METHODS).toHaveLength(19);
    expect(SLICE_3C_METHODS).toHaveLength(8);
    expect(SLICE_3D_METHODS).toHaveLength(11);
    expect(SLICE_3E_METHODS).toHaveLength(14);
    expect(SLICE_3F_METHODS).toHaveLength(24);
  });

  it("bounds the instruction, part ids and list limits", () => {
    const thread = { messageId: "m", include: "message", projectId: "p" };
    expect(parses("bb_thread_prepare", { ...thread, instruction: "x".repeat(4_000) })).toBe(true);
    expect(parses("bb_thread_prepare", { ...thread, instruction: "x".repeat(4_001) })).toBe(false);
    expect(parses("bb_thread_prepare", { ...thread, include: "folder" })).toBe(false);
    expect(parses("bb_thread_start", { ...thread, saveAttachments: true, ruleRunId: "r1" })).toBe(true);
    expect(parses("incident_start", { messageId: "m", projectId: "p", instruction: "x".repeat(4_001) })).toBe(false);
    const save = { messageId: "m", projectId: "p", onConflict: "ask" };
    expect(parses("attachment_save", { ...save, partIds: Array.from({ length: 20 }, (_, i) => `${i}`) })).toBe(true);
    expect(parses("attachment_save", { ...save, partIds: Array.from({ length: 21 }, (_, i) => `${i}`) })).toBe(false);
    expect(parses("attachment_save", { ...save, partIds: [] })).toBe(false);
    expect(parses("attachment_save", { ...save, partIds: ["1"], folder: "a".repeat(240) })).toBe(true);
    expect(parses("attachment_save", { ...save, partIds: ["1"], folder: "a".repeat(241) })).toBe(false);
    expect(parses("attachment_save", { ...save, partIds: ["1"], onConflict: "overwrite" })).toBe(false);
    expect(parses("attachment_save", { ...save, partIds: ["1"], onConflict: "replace", replaceSha: "nope" })).toBe(false);
    expect(parses("project_files", { projectId: "p", query: "", limit: 50 })).toBe(true);
    expect(parses("project_files", { projectId: "p", query: "", limit: 51 })).toBe(false);
    expect(parses("project_folders", { projectId: "p", query: "q".repeat(201), limit: 5 })).toBe(false);
    expect(parses("thread_files", { bbThreadId: "t", limit: 51 })).toBe(false);
    expect(parses("bb_threads_recent", { projectId: "p", limit: 30 })).toBe(true);
    expect(parses("bb_threads_recent", { projectId: "p", limit: 31 })).toBe(false);
    expect(parses("dev_digest_get", { days: 31 })).toBe(false);
    expect(parses("dev_digest_get", {})).toBe(true);
  });

  it("bounds the task title and note and checks the target", () => {
    const task = { messageId: "m", target: { kind: "taskboard", boardId: "b" }, excerpt: true };
    expect(parses("task_from_mail", { ...task, title: "t".repeat(500), note: "n".repeat(4_000) })).toBe(true);
    expect(parses("task_from_mail", { ...task, title: "t".repeat(501) })).toBe(false);
    expect(parses("task_from_mail", { ...task, title: "t", note: "n".repeat(4_001) })).toBe(false);
    expect(parses("task_from_mail", { ...task, title: "" })).toBe(false);
    expect(parses("task_from_mail", { ...task, title: "t", target: { kind: "local", due: "2026-11-20" } })).toBe(true);
    expect(parses("task_from_mail", { ...task, title: "t", target: { kind: "jira" } })).toBe(false);
    expect(outputs("task_from_mail", { kind: "unavailable", reason: "Taskboard did not answer" })).toBe(true);
  });

  it("bounds draft_from_bb's text and compose_attach_bb's sources", () => {
    expect(parses("draft_from_bb", { bbThreadId: "t", source: { kind: "output" } })).toBe(true);
    expect(parses("draft_from_bb", { bbThreadId: "t", source: { kind: "message", text: "x".repeat(100_000) } })).toBe(true);
    expect(parses("draft_from_bb", { bbThreadId: "t", source: { kind: "message", text: "x".repeat(100_001) } })).toBe(false);
    expect(parses("compose_attach_bb", { draftId: "d", source: { kind: "project", projectId: "p", path: "src/a.ts" } })).toBe(true);
    expect(parses("compose_attach_bb", { draftId: "d", source: { kind: "thread", bbThreadId: "t", path: "out.md" }, confirmed: true })).toBe(true);
    expect(parses("compose_attach_bb", { draftId: "d", source: { kind: "project", projectId: "p", path: "a\nb" } })).toBe(false);
    expect(parses("compose_attach_bb", { draftId: "d", source: { kind: "host", path: "a" } })).toBe(false);
  });

  it("takes patch refs as sha256 hex and the checkout fallback only by name", () => {
    const patch = { messageId: "m", projectId: "p", patchRef: SHA };
    expect(parses("patch_save", patch)).toBe(true);
    expect(parses("patch_save", { ...patch, patchRef: "C".repeat(64) })).toBe(false);
    expect(parses("patch_handoff", { ...patch, environment: "checkout" })).toBe(true);
    expect(parses("patch_handoff", { ...patch, environment: "host" })).toBe(false);
  });

  it("bounds rule names, templates and match lists, and needs the confirmation for start mode", () => {
    expect(parses("rule_save", rule())).toBe(true);
    expect(parses("rule_save", rule({ name: "n".repeat(80) }))).toBe(true);
    expect(parses("rule_save", rule({ name: "n".repeat(81) }))).toBe(false);
    expect(parses("rule_save", rule({ name: "a\nb" }))).toBe(false);
    expect(parses("rule_save", rule({ template: "t".repeat(4_000) }))).toBe(true);
    expect(parses("rule_save", rule({ template: "t".repeat(4_001) }))).toBe(false);
    const addresses = (n: number) => Array.from({ length: n }, (_, i) => `a${i}@example.com`);
    expect(parses("rule_save", rule({ match: { from: addresses(20) } }))).toBe(true);
    expect(parses("rule_save", rule({ match: { from: addresses(21) } }))).toBe(false);
    expect(parses("rule_save", rule({ match: { domains: Array.from({ length: 21 }, (_, i) => `d${i}.example.com`) } }))).toBe(false);
    expect(parses("rule_save", rule({ match: { subjectWords: Array.from({ length: 11 }, (_, i) => `w${i}`) } }))).toBe(false);
    expect(parses("rule_save", rule({ match: { accounts: Array.from({ length: 51 }, (_, i) => `a${i}`) } }))).toBe(false);
    expect(parses("rule_save", rule({ match: { dev: { kind: "nope" } } }))).toBe(false);
    expect(parses("rule_save", rule({ mode: "start" }))).toBe(false);
    expect(parses("rule_save", rule({ mode: "start", confirmedStart: false }))).toBe(false);
    expect(parses("rule_save", rule({ mode: "start", confirmedStart: true }))).toBe(true);
    expect(parses("rules_pause", { undo: true })).toBe(true);
    expect(parses("rule_runs_list", { state: "starting" })).toBe(true);
    expect(parses("rule_runs_list", { state: "running" })).toBe(false);
  });

  it("bounds binding values and kinds", () => {
    expect(parses("binding_add", { kind: "repo", value: "github.com/example-org/demo", projectId: "p" })).toBe(true);
    expect(parses("binding_add", { kind: "folder", value: "x", projectId: "p" })).toBe(false);
    expect(parses("binding_add", { kind: "domain", value: "x".repeat(321), projectId: "p" })).toBe(false);
    expect(parses("binding_add", { kind: "address", value: "a@example.com\r\nX", projectId: "p" })).toBe(false);
    expect(parses("conversation_project_set", { accountId: "a", threadId: "t", projectId: null })).toBe(true);
  });

  it("adds the rule day notice and refuses extra keys on it", () => {
    expect(outputs("day_notice_get", { kind: "rule", ruleName: "CI failures", count: 2 })).toBe(true);
    expect(outputs("day_notice_get", { kind: "rule", ruleName: "CI failures", count: 2, subject: "x" })).toBe(false);
    expect(outputs("day_notice_get", { kind: "rule", ruleName: "CI failures", count: 0 })).toBe(false);
  });

  it("adds the 3g fields to the model and the Today view", () => {
    expect(Object.keys(messageHeaderSchema.shape)).toEqual(
      expect.arrayContaining(["devLinks", "dev", "patch", "alert", "bbLinks"]),
    );
    expect(Object.keys(threadSummarySchema.shape)).toEqual(expect.arrayContaining(["projectId"]));
    expect(Object.keys(threadDetailSchema.shape)).toEqual(expect.arrayContaining(["project", "projectSuggestion"]));
    expect(Object.keys(messageBodySchema.shape)).toEqual(expect.arrayContaining(["codeBlocks"]));
    expect(Object.keys(taskViewSchema.shape)).toEqual(expect.arrayContaining(["note"]));
    expect(Object.keys(composeAttachmentSchema.shape)).toEqual(expect.arrayContaining(["origin"]));
    const list = { scope: { kind: "account", accountId: "a", folder: "INBOX" }, cursor: null, limit: 50 };
    expect(parses("threads_list", { ...list, filter: { notDev: true, projectId: "p" } })).toBe(true);
    expect(parses("threads_list", { ...list, filter: { notDev: false } })).toBe(false);
    expect(Object.keys(rpcSchemas.today_get.output.shape)).toEqual(expect.arrayContaining(["dev", "rulesReady"]));
  });

  it("names every refusal kind with a fixed text", () => {
    expect(Object.keys(BB_REFUSAL_TEXT)).toEqual(expect.arrayContaining(["out_of_scope", "no_tree", "confirm_needed", "in_flight"]));
  });

  it("puts no credential-like key in any new output; sensitiveName, alertRef, patchRef and permissionMode pass", () => {
    for (const method of SLICE_3G_METHODS) {
      const keys = keysOf(rpcSchemas[method].output);
      expect(keys.length, method).toBeGreaterThan(0);
      expect(keys.filter((key) => SECRET_KEY.test(key)), method).toEqual([]);
    }
    for (const key of ["sensitiveName", "alertRef", "patchRef", "permissionMode"]) expect(SECRET_KEY.test(key), key).toBe(false);
    expect(keysOf(rpcSchemas.alert_view.output)).toContain("alertRef");
    expect(keysOf(rpcSchemas.patch_view.output)).toContain("patchRef");
    expect(keysOf(rpcSchemas.bb_thread_prepare.output)).toContain("permissionMode");
    for (const schema of [messageHeaderSchema, threadDetailSchema, messageBodySchema, rpcSchemas.today_get.output]) {
      expect(keysOf(schema).filter((key) => SECRET_KEY.test(key))).toEqual([]);
    }
  });
});

describe("slice 3h contract", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) => rpcSchemas[method].input.safeParse(input).success;
  const earlier = [...COMPOSE_METHODS, ...SLICE_3C_METHODS, ...SLICE_3D_METHODS, ...SLICE_3E_METHODS, ...SLICE_3F_METHODS, ...SLICE_3G_METHODS];

  it("adds exactly 28 methods to the 126 before it, leaving the earlier lists alone", () => {
    expect(SLICE_3H_METHODS).toHaveLength(28);
    expect(new Set(SLICE_3H_METHODS).size).toBe(28);
    expect(
      Object.keys(rpcSchemas).filter((m) => !([...SLICE_3I_METHODS, ...SLICE_3K_METHODS, ...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m)),
    ).toHaveLength(154);
    for (const method of SLICE_3H_METHODS) expect(earlier as readonly string[], method).not.toContain(method);
    expect(SLICE_3G_METHODS).toHaveLength(33);
  });

  it("puts no credential-like key in any new output, nor in the changed search and model views", () => {
    for (const method of SLICE_3H_METHODS) {
      const keys = keysOf(rpcSchemas[method].output);
      expect(keys.length, method).toBeGreaterThan(0);
      expect(keys.filter((key) => SECRET_KEY.test(key)), method).toEqual([]);
    }
    for (const schema of [rpcSchemas.search.output, messageSummarySchema, messageHeaderSchema, folderSchema]) {
      expect(keysOf(schema).filter((key) => SECRET_KEY.test(key))).toEqual([]);
    }
    expect(keysOf(rpcSchemas.search.output)).toEqual(
      expect.arrayContaining(["hits", "nextCursor", "notes", "attachmentMatches", "excerpt", "kept", "labels"]),
    );
    expect(keysOf(rpcSchemas.server_job_poll.output)).toEqual(expect.arrayContaining(["skipped", "reason"]));
    expect(keysOf(rpcSchemas.folder_delete_check.output)).toContain("gmailLabel");
    expect(keysOf(rpcSchemas.attachment_text_status.output)).toContain("full");
  });

  it("keeps search input without attachments or cursor parsing as before", () => {
    expect(parses("search", { query: "invoice", accountId: null, limit: 50 })).toBe(true);
    expect(parses("search", { query: "invoice", accountId: null, limit: 50, attachments: true, cursor: "c1" })).toBe(true);
    expect(parses("search", { query: "invoice", accountId: null, limit: 50, cursor: null })).toBe(true);
    expect(parses("search", { query: "invoice", accountId: null, limit: 50, attachments: "yes" })).toBe(false);
  });

  it("bounds queries at 500, saved-search names at 60 and folder names at 100", () => {
    const q = (query: string) => ({ query, accountId: null });
    expect(parses("server_search_start", q("x".repeat(500)))).toBe(true);
    expect(parses("server_search_start", q("x".repeat(501)))).toBe(false);
    expect(parses("server_search_start", q(""))).toBe(false);
    const saved = (name: string, query = "from:a@example.org") => ({ name, query, accountId: null });
    expect(parses("saved_search_save", saved("n".repeat(60)))).toBe(true);
    expect(parses("saved_search_save", saved("n".repeat(61)))).toBe(false);
    expect(parses("saved_search_save", saved("n", "q".repeat(501)))).toBe(false);
    expect(parses("saved_search_move", { id: "s1", position: 49 })).toBe(true);
    expect(parses("saved_search_move", { id: "s1", position: 50 })).toBe(false);
    const create = (name: string) => ({ accountId: "a1", parent: null, name });
    expect(parses("folder_create", create("f".repeat(100)))).toBe(true);
    expect(parses("folder_create", create("f".repeat(101)))).toBe(false);
    expect(parses("folder_create", create(""))).toBe(false);
    expect(parses("folder_rename", { accountId: "a1", path: "Work", name: "f".repeat(101) })).toBe(false);
  });

  it("bounds label changes: up to 200 messages and 20 labels each way, at least one label", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
    const labels = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`);
    expect(parses("labels_change", { messageIds: ids(200), add: labels(20), remove: [] })).toBe(true);
    expect(parses("labels_change", { messageIds: ids(201), add: labels(1), remove: [] })).toBe(false);
    expect(parses("labels_change", { messageIds: ids(1), add: labels(21), remove: [] })).toBe(false);
    expect(parses("labels_change", { messageIds: ids(1), add: [], remove: labels(21) })).toBe(false);
    expect(parses("labels_change", { messageIds: ids(1), add: [], remove: [] })).toBe(false);
    expect(parses("labels_change", { messageIds: ids(1), add: ["l".repeat(101)], remove: [] })).toBe(false);
    expect(parses("labels_change", { messageIds: [], add: ["A"], remove: [] })).toBe(false);
  });

  it("bounds list limits and files filters", () => {
    const files = (extra: object) => ({ cursor: null, limit: 100, ...extra });
    expect(parses("files_list", files({}))).toBe(true);
    expect(parses("files_list", files({ limit: 101 }))).toBe(false);
    expect(parses("files_list", files({ kind: "pdf", includeJunk: true }))).toBe(true);
    expect(parses("files_list", files({ kind: "exe" }))).toBe(false);
    const scope = { kind: "account", accountId: "a1", folder: "INBOX" };
    expect(parses("messages_list", { scope, cursor: null, limit: 100 })).toBe(true);
    expect(parses("messages_list", { scope, cursor: null, limit: 101 })).toBe(false);
    expect(parses("folder_delete", { accountId: "a1", path: "Work", moveToTrash: false, expectedMessages: -1 })).toBe(false);
    expect(parses("folder_prefs_set", { accountId: "*", path: "inbox", grouping: false })).toBe(true);
  });

  it("refuses empty and overlong ids in every new method that takes one", () => {
    const long = "x".repeat(257);
    expect(parses("server_job_poll", { jobId: "" })).toBe(false);
    expect(parses("server_job_poll", { jobId: long })).toBe(false);
    expect(parses("history_load", { accountId: "a1", folder: long })).toBe(false);
    expect(parses("conversation_load", { threadId: "" })).toBe(false);
    expect(parses("attachment_view_ticket", { messageId: "m1", partId: "" })).toBe(false);
    expect(parses("related_messages", { messageId: long })).toBe(false);
    expect(parses("sender_card", { address: "a@", accountId: null })).toBe(false);
    expect(parses("sender_card", { address: "a@example.org", accountId: null })).toBe(true);
  });
});

describe("slice 3i contract", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) => rpcSchemas[method].input.safeParse(input).success;

  it("adds exactly one method to the 154 before it", () => {
    expect(SLICE_3I_METHODS).toEqual(["sender_check_refresh"]);
    expect(
      Object.keys(rpcSchemas).filter((m) => !([...SLICE_3K_METHODS, ...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m)),
    ).toHaveLength(155);
  });

  it("bounds sender_check_refresh to 1-50 ids", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `m_${i}`);
    expect(parses("sender_check_refresh", { messageIds: ids(1) })).toBe(true);
    expect(parses("sender_check_refresh", { messageIds: ids(50), force: true })).toBe(true);
    expect(parses("sender_check_refresh", { messageIds: [] })).toBe(false);
    expect(parses("sender_check_refresh", { messageIds: ids(51) })).toBe(false);
    expect(parses("sender_check_refresh", { messageIds: [""] })).toBe(false);
    expect(parses("sender_check_refresh", { messageIds: ids(1), force: "yes" })).toBe(false);
  });

  it("puts no credential-like or token key in any new or changed output", () => {
    const strict = /pass|secret|seal|key|token/i;
    for (const schema of [rpcSchemas.sender_check_refresh.output, rpcSchemas.message_source.output, messageHeaderSchema]) {
      expect(keysOf(schema).filter((key) => strict.test(key))).toEqual([]);
    }
    expect(keysOf(rpcSchemas.sender_check_refresh.output)).toEqual(expect.arrayContaining(["refreshed", "failed"]));
    expect(keysOf(rpcSchemas.message_source.output)).toEqual(expect.arrayContaining(["authenticity", "authserv", "lines"]));
    expect(keysOf(messageHeaderSchema)).toEqual(
      expect.arrayContaining(["senderCheck", "state", "summary", "warnings", "receiptRequested", "crypto", "opaque"]),
    );
  });

  it("defaults the new header fields so older headers still parse", () => {
    const header = {
      id: "m_1",
      accountId: "acc_1",
      folder: "INBOX",
      threadId: "t_1",
      date: null,
      from: { name: null, address: "a@example.com" },
      subject: "Hello",
      snippet: "",
      isRead: false,
      isFlagged: false,
      hasAttachments: false,
      kept: null,
      labels: [],
      to: [],
      cc: [],
      attachments: [],
      draftId: null,
      agentSubject: "Hello",
      inAiScope: true,
      devLinks: [],
      dev: null,
      patch: null,
      alert: false,
      bbLinks: [],
    };
    const parsed = messageHeaderSchema.parse(header);
    expect(parsed.senderCheck).toEqual({ state: "unknown", summary: null });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.receiptRequested).toBe(false);
    expect(parsed.crypto).toBeNull();
    const full = messageHeaderSchema.parse({
      ...header,
      senderCheck: { state: "failed", summary: "DMARC failed" },
      warnings: [
        { kind: "reply_to_elsewhere", addresses: ["help@example.net"] },
        { kind: "lookalike", domain: "examp1e.com", like: "example.com" },
        { kind: "mixed_script", domain: "xn--shp-ted.example.org" },
        { kind: "name_shows_address", shown: "ceo@example.com", actual: "x@example.org" },
      ],
      receiptRequested: true,
      crypto: { kind: "smime_signed", opaque: true },
    });
    expect(full.warnings).toHaveLength(4);
    expect(messageHeaderSchema.safeParse({ ...header, senderCheck: { state: "verified", summary: null } }).success).toBe(false);
    expect(messageHeaderSchema.safeParse({ ...header, crypto: { kind: "pgp", opaque: false } }).success).toBe(false);
  });

  it("defaults message_source's authenticity block", () => {
    const base = { headers: [], structure: [], size: 1, uid: 1, folder: "INBOX", accountEmail: "a@example.com" };
    expect(rpcSchemas.message_source.output.parse(base).authenticity).toEqual({ authserv: null, lines: [] });
  });

  it("keeps the view enums in step with the core", () => {
    expect([...SENDER_CHECK_STATES]).toEqual(["ok", "failed", "unchecked", "unknown"]);
    expect([...CRYPTO_KINDS]).toEqual(["pgp_signed", "pgp_encrypted", "smime_signed", "smime_encrypted"]);
    expect([...DISGUISE_WARNING_KINDS]).toEqual(["reply_to_elsewhere", "lookalike", "mixed_script", "name_shows_address"]);
    expect(senderCheckViewSchema.shape.state.options).toEqual([...SENDER_CHECK_STATES]);
    expect(mailCryptoSchema.shape.kind.options).toEqual([...CRYPTO_KINDS]);
  });
});

describe("slice 3k contract (OpenPGP)", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) =>
    rpcSchemas[method].input.safeParse(input).success;

  it("adds exactly nine methods to the 155 before it", () => {
    expect(SLICE_3K_METHODS).toHaveLength(9);
    expect(new Set(SLICE_3K_METHODS).size).toBe(9);
    expect(
      Object.keys(rpcSchemas).filter((m) => !([...SLICE_3L_METHODS, ...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m)),
    ).toHaveLength(164);
  });

  it("names no output after a credential, and offers a private key only as an export locked by a passphrase", () => {
    for (const method of SLICE_3K_METHODS) {
      expect(keysOf(rpcSchemas[method].output).filter((name) => SECRET_KEY.test(name)), method).toEqual([]);
    }
    expect(keysOf(rpcSchemas.pgp_certs_list.output)).not.toContain("armor");
    expect(keysOf(rpcSchemas.pgp_cert_generate.output)).not.toContain("armor");
    // A backup passphrase is at least 8 characters; without one the export is the public key.
    expect(parses("pgp_cert_export", { id: "pgp_1" })).toBe(true);
    expect(parses("pgp_cert_export", { id: "pgp_1", phrase: "short" })).toBe(false);
    expect(parses("pgp_cert_export", { id: "pgp_1", phrase: "long enough words" })).toBe(true);
  });

  it("bounds the pasted armor and the recipients", () => {
    expect(parses("pgp_cert_import", { armor: "x".repeat(200_001) })).toBe(false);
    expect(parses("pgp_cert_import", { armor: "x" })).toBe(true);
    expect(parses("pgp_check", { from: "a@example.org", recipients: Array.from({ length: 101 }, (_, i) => `r${i}@example.org`) })).toBe(false);
    expect(parses("pgp_check", { from: "a@example.org\r\nBcc: x@example.org", recipients: [] })).toBe(false);
  });

  it("lets compose_send ask for signing and encryption", () => {
    const base = { draftId: "d_1", baseRevision: 1, requestId: "00000000-0000-4000-8000-000000000001" };
    expect(parses("compose_send", base)).toBe(true);
    expect(parses("compose_send", { ...base, protect: { sign: true, encrypt: false } })).toBe(true);
    expect(parses("compose_send", { ...base, protect: { sign: "yes" } })).toBe(false);
  });
});

describe("slice 3l contract (Send later, calendar invitations)", () => {
  const parses = (method: keyof typeof rpcSchemas, input: unknown) =>
    rpcSchemas[method].input.safeParse(input).success;

  it("adds exactly two methods to the 164 before it", () => {
    expect(SLICE_3L_METHODS).toEqual(["invite_view", "invite_reply"]);
    expect(
      Object.keys(rpcSchemas).filter((m) => !([...SLICE_3M_METHODS, ...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m)),
    ).toHaveLength(166);
    for (const method of SLICE_3L_METHODS) {
      expect(keysOf(rpcSchemas[method].output).filter((name) => SECRET_KEY.test(name)), method).toEqual([]);
    }
  });

  it("takes one of three answers and a request id", () => {
    const base = { messageId: "m_1", requestId: "00000000-0000-4000-8000-000000000001" };
    for (const answer of ["accepted", "tentative", "declined"]) expect(parses("invite_reply", { ...base, answer })).toBe(true);
    expect(parses("invite_reply", { ...base, answer: "delegated" })).toBe(false);
    expect(parses("invite_reply", { messageId: "m_1", answer: "accepted" })).toBe(false);
    expect(parses("invite_reply", { ...base, answer: "accepted", requestId: "again" })).toBe(false);
  });

  it("lets compose_send carry a time to send at, as an ISO instant only", () => {
    const base = { draftId: "d_1", baseRevision: 1, requestId: "00000000-0000-4000-8000-000000000001" };
    expect(parses("compose_send", { ...base, sendAt: "2026-11-20T09:00:00.000Z" })).toBe(true);
    expect(parses("compose_send", { ...base, sendAt: "tomorrow" })).toBe(false);
    expect(parses("compose_send", { ...base, sendAt: "2026-11-20 09:00" })).toBe(false);
  });

  it("marks a scheduled row and the invitation answer's purpose on an Outbox row", () => {
    expect(outboxRowSchema.shape.purpose.unwrap().unwrap().options).toEqual(["unsubscribe", "invite_reply"]);
    expect(outboxRowSchema.shape.scheduled.safeParse(true).success).toBe(true);
    expect(outboxRowSchema.shape.scheduled.safeParse(undefined).success).toBe(true);
  });
});

describe("slice 3m contract (filters)", () => {
  const parses = (input: unknown) => rpcSchemas.filter_save.input.safeParse(input).success;
  const base = {
    name: "Invented",
    enabled: true,
    match: { domains: ["news.example.com"] },
    actions: { move: "none", folder: null, markRead: true, flag: false },
  };

  it("adds exactly three methods to the 166 before it", () => {
    expect(SLICE_3M_METHODS).toEqual(["filters_list", "filter_save", "filter_delete"]);
    expect(
      Object.keys(rpcSchemas).filter((m) => !([...SLICE_3N_METHODS, ...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m)),
    ).toHaveLength(169);
    for (const method of SLICE_3M_METHODS) {
      expect(keysOf(rpcSchemas[method].output).filter((name) => SECRET_KEY.test(name)), method).toEqual([]);
    }
  });

  it("bounds a filter: four moves, no dev match, no line breaks in a name or a folder", () => {
    expect(parses(base)).toBe(true);
    for (const move of ["none", "archive", "trash", "folder"]) expect(parses({ ...base, actions: { ...base.actions, move } })).toBe(true);
    expect(parses({ ...base, actions: { ...base.actions, move: "delete" } })).toBe(false);
    expect(parses({ ...base, actions: { ...base.actions, folder: "A\r\nB" } })).toBe(false);
    expect(parses({ ...base, actions: { ...base.actions, folder: "x".repeat(1001) } })).toBe(false);
    expect(parses({ ...base, name: "A\nB" })).toBe(false);
    expect(parses({ ...base, match: { from: Array.from({ length: 21 }, (_, i) => `a${i}@example.com`) } })).toBe(false);
    const withDev = rpcSchemas.filter_save.input.parse({ ...base, match: { ...base.match, dev: { kind: "alert" } } });
    expect("dev" in withDev.match).toBe(false);
  });
});

describe("slice 3n contract (subscriptions overview)", () => {
  it("adds one method to the 169 before it, and its output never carries a list key", () => {
    expect(SLICE_3N_METHODS).toEqual(["subscriptions_list"]);
    expect(Object.keys(rpcSchemas).filter((m) => !([...SLICE_3P_METHODS, ...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m))).toHaveLength(170);
    const keys = keysOf(rpcSchemas.subscriptions_list.output);
    expect(keys.filter((name) => SECRET_KEY.test(name))).toEqual([]);
    expect(keys).not.toContain("listKey");
    expect(rpcSchemas.subscriptions_list.input.safeParse({ accountId: null }).success).toBe(true);
    expect(rpcSchemas.subscriptions_list.input.safeParse({}).success).toBe(false);
  });
});

describe("slice 3p contract (local archive)", () => {
  it("adds five methods to the 170 before it, none naming a credential", () => {
    expect(SLICE_3P_METHODS).toHaveLength(5);
    expect(Object.keys(rpcSchemas).filter((m) => !([...SIGN_IN_METHODS, ...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m))).toHaveLength(175);
    for (const method of SLICE_3P_METHODS) {
      expect(keysOf(rpcSchemas[method].output).filter((name) => SECRET_KEY.test(name)), method).toEqual([]);
    }
  });

  it("bounds the search text and the cursor", () => {
    const parses = (input: unknown) => rpcSchemas.archive_messages.input.safeParse(input).success;
    expect(parses({ archiveId: null, query: "", cursor: null })).toBe(true);
    expect(parses({ archiveId: "arc_1", query: "zebra", cursor: { date: null, id: "12" } })).toBe(true);
    expect(parses({ archiveId: null, query: "x".repeat(201), cursor: null })).toBe(false);
    expect(parses({ archiveId: null, query: "", cursor: { date: "x".repeat(41), id: "1" } })).toBe(false);
    expect(parses({ archiveId: null, query: "" })).toBe(false);
  });
});

describe("retry sign-in contract", () => {
  it("adds one method to the 175 before it, and it carries no credential", () => {
    expect(SIGN_IN_METHODS).toEqual(["accounts_retry_sign_in"]);
    expect(Object.keys(rpcSchemas).filter((m) => !([...GOOGLE_METHODS, ...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m))).toHaveLength(176);
    expect(keysOf(rpcSchemas.accounts_retry_sign_in.input)).toEqual(["accountId"]);
    expect(keysOf(rpcSchemas.accounts_retry_sign_in.output)).toEqual(["result"]);
  });

  it("answers with one of five fixed results", () => {
    const parses = (result: unknown) => rpcSchemas.accounts_retry_sign_in.output.safeParse({ result }).success;
    for (const result of ["resumed", "refused", "unreachable", "unreadable", "sign_in_needed"]) expect(parses(result), result).toBe(true);
    expect(parses("Authentication failed")).toBe(false);
  });
});

describe("Google sign-in contract", () => {
  it("adds two methods to the 176 before it, and neither carries a token, a code or the client", () => {
    expect(GOOGLE_METHODS).toEqual(["google_sign_in_start", "google_sign_in_status"]);
    expect(Object.keys(rpcSchemas).filter((m) => !([...SETTINGS_METHODS, ...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m))).toHaveLength(178);
    expect(keysOf(rpcSchemas.google_sign_in_start.input)).toEqual(["email", "extraScopes"]);
    const start = (input: unknown) => rpcSchemas.google_sign_in_start.input.safeParse(input).success;
    expect(start({ email: null, extraScopes: ["https://www.googleapis.com/auth/calendar"] })).toBe(true);
    // Nothing but the two plugin-key services can be added to a sign-in; mail is never asked for through here.
    expect(start({ email: null, extraScopes: ["https://mail.google.com/"] })).toBe(false);
    expect(start({ email: null, extraScopes: ["https://www.googleapis.com/auth/drive"] })).toBe(false);
    expect(keysOf(rpcSchemas.google_sign_in_start.output)).toEqual(["flowId", "url"]);
    expect(keysOf(rpcSchemas.google_sign_in_status.input)).toEqual(["flowId"]);
  });

  it("reads a flow as pending, done or failed with a fixed reason", () => {
    const parses = (value: unknown) => rpcSchemas.google_sign_in_status.output.safeParse(value).success;
    expect(parses({ state: "pending" })).toBe(true);
    expect(parses({ state: "done", accountId: "acc_1" })).toBe(true);
    expect(parses({ state: "failed", reason: "mismatch" })).toBe(true);
    expect(parses({ state: "failed", reason: "Token has been expired or revoked." })).toBe(false);
    expect(parses({ state: "done" })).toBe(false);
    expect(rpcSchemas.google_sign_in_start.input.safeParse({ email: null }).success).toBe(true);
    expect(rpcSchemas.google_sign_in_start.input.safeParse({ email: "x".repeat(321) }).success).toBe(false);
    expect(rpcSchemas.google_sign_in_start.input.safeParse({}).success).toBe(false);
  });
});

describe("settings page contract", () => {
  it("adds two methods to the 178 before it; neither names the credential key", () => {
    expect(SETTINGS_METHODS).toEqual(["settings_get", "settings_set"]);
    expect(Object.keys(rpcSchemas).filter((m) => !([...PLUGIN_METHODS, ...INBOX_TAB_METHODS, ...TYPING_METHODS, ...AI_WRITE_METHODS, ...AI_SORT_METHODS] as readonly string[]).includes(m))).toHaveLength(180);
    expect(keysOf(rpcSchemas.settings_get.output)).not.toContain("vaultKey");
    expect(keysOf(rpcSchemas.settings_get.output)).toHaveLength(40);
  });

  it("settings_set takes writable keys only", () => {
    const parses = (input: unknown) => rpcSchemas.settings_set.input.safeParse(input).success;
    expect(parses({ hideQuotes: false })).toBe(true);
    expect(parses({ agentTools: true })).toBe(false);
    expect(parses({ vaultKey: "x" })).toBe(false);
    expect(parses({})).toBe(false);
  });
});
