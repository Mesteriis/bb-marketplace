import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { MAIL_CHANGED_CHANNEL, rpcSchemas } from "./contract.ts";
import { accountSchema, statusViewSchema } from "./model.ts";

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
  it("declares exactly the first-slice methods", () => {
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

  it("names the realtime channel", () => {
    expect(MAIL_CHANGED_CHANNEL).toBe("mail-changed");
  });
});

describe("credential-free views", () => {
  it.each([
    ["statusViewSchema", statusViewSchema],
    ["accountSchema", accountSchema],
  ])("%s has no secret-like key", (_name, schema) => {
    const keys = keysOf(schema);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => SECRET_KEY.test(key))).toEqual([]);
  });
});
