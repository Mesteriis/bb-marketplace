import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { MAIL_CHANGED_CHANNEL, rpcSchemas } from "./contract.ts";
import {
  accountSchema,
  folderSchema,
  messageActionSchema,
  messageHeaderSchema,
  messageSummarySchema,
  specialUseSchema,
  statusViewSchema,
  threadSummarySchema,
} from "./model.ts";

const SECRET_KEY = /pass|secret|seal|key/i;

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
  it("declares exactly the slice-1 methods plus the slice-2 and slice-3a additions", () => {
    expect(Object.keys(rpcSchemas).sort()).toEqual(
      [
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
