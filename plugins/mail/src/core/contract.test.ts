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
  return [];
}

describe("rpcSchemas", () => {
  it("declares exactly the slice-1 methods plus the slice-2 additions", () => {
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
      rpcSchemas.threads_list.input.safeParse({ accountId: "a", cursor: null, limit: 101 })
        .success,
    ).toBe(false);
    expect(
      rpcSchemas.search.input.safeParse({ query: "x", accountId: null, limit: 51 }).success,
    ).toBe(false);
    expect(
      rpcSchemas.search.input.safeParse({ query: "", accountId: null, limit: 10 }).success,
    ).toBe(false);
  });

  it("requires a folder when listing threads", () => {
    expect(
      rpcSchemas.threads_list.input.safeParse({ accountId: "a", cursor: null, limit: 10 }).success,
    ).toBe(false);
    expect(
      rpcSchemas.threads_list.input.safeParse({
        accountId: "a",
        folder: "INBOX",
        cursor: null,
        limit: 10,
      }).success,
    ).toBe(true);
  });

  it("bounds message_action to 1..200 ids and the four actions", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `m_${i}`);
    const parse = (messageIds: string[], action: string) =>
      rpcSchemas.message_action.input.safeParse({ messageIds, folder: "INBOX", action }).success;
    expect(parse(ids(1), "spam")).toBe(true);
    expect(parse(ids(200), "delete")).toBe(true);
    expect(parse([], "archive")).toBe(false);
    expect(parse(ids(201), "not_spam")).toBe(false);
    expect(parse(ids(1), "expunge")).toBe(false);
    expect(parse([""], "spam")).toBe(false);
    expect(parse(["x".repeat(257)], "spam")).toBe(false);
    expect(
      rpcSchemas.message_action.input.safeParse({ messageIds: ["m"], action: "spam" }).success,
    ).toBe(false);
    expect(
      rpcSchemas.message_action.input.safeParse({ messageIds: ["m"], folder: "", action: "spam" })
        .success,
    ).toBe(false);
    expect(messageActionSchema.options).toEqual(["spam", "not_spam", "archive", "delete"]);
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
    expect(rpcSchemas.folders_list.output.safeParse({ folders: [] }).success).toBe(true);
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
    expect(
      rpcSchemas.message_action.output.safeParse({ queued: 2, destination: "Trash" }).success,
    ).toBe(true);
    expect(
      rpcSchemas.message_action.output.safeParse({ queued: -1, destination: "Trash" }).success,
    ).toBe(false);
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
      rpcSchemas.threads_list.input.safeParse({ accountId: "a", folder: "", cursor: null, limit: 1 })
        .success,
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
});
