import { describe, expect, it } from "vitest";
import { panelRefKey, panelRefSchema } from "../../../src/core/panels/index.ts";

describe("panelRefSchema", () => {
  it("accepts a provider type with primitive restore parameters", () => {
    const parsed = panelRefSchema.safeParse({
      provider: "bb-thread",
      params: { threadId: "thr_a", pinned: true, column: 2 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ provider: "bb-thread", params: { threadId: "thr_a", pinned: true, column: 2 } });
  });

  it("accepts a reference without parameters", () => {
    expect(panelRefSchema.safeParse({ provider: "terminals", params: {} }).success).toBe(true);
  });

  it.each([
    ["an extra top-level field", { provider: "bb-thread", params: {}, instanceId: "panel-1" }],
    ["a live handle next to the parameters", { provider: "bb-thread", params: {}, webContentsId: 7 }],
    ["a missing provider", { params: {} }],
    ["an empty provider", { provider: "", params: {} }],
    ["a provider that is not a lowercase slug", { provider: "BB Thread", params: {} }],
    ["missing parameters", { provider: "bb-thread" }],
    ["a nested parameter", { provider: "bb-thread", params: { target: { id: "thr_a" } } }],
    ["a list parameter", { provider: "bb-thread", params: { ids: ["thr_a"] } }],
    ["a null parameter", { provider: "bb-thread", params: { threadId: null } }],
    ["a non-finite number", { provider: "bb-thread", params: { column: Number.POSITIVE_INFINITY } }],
    ["an empty parameter name", { provider: "bb-thread", params: { "": "x" } }],
  ])("rejects %s", (_name, value) => {
    expect(panelRefSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["password"],
    ["sshPassword"],
    ["passcode"],
    ["pwd"],
    ["accessToken"],
    ["api_key"],
    ["apiKey"],
    ["clientSecret"],
    ["credentials"],
    ["sessionCookie"],
    ["Authorization"],
  ])("rejects the credential parameter %s", (name) => {
    expect(panelRefSchema.safeParse({ provider: "remote-hub", params: { [name]: "x" } }).success).toBe(false);
  });

  it.each([
    ["text"],
    ["draft"],
    ["body"],
    ["message"],
    ["content"],
    ["caption"],
    ["messageText"],
    ["previewText"],
    ["draft_text"],
    ["reply-body"],
    ["lastMessage"],
    ["quotedMessages"],
    ["TEXT"],
    ["snippet"],
    ["transcript"],
    ["subject"],
    ["replyQuote"],
  ])(
    "rejects the correspondence parameter %s",
    (name) => {
      expect(panelRefSchema.safeParse({ provider: "telegram", params: { [name]: "hello" } }).success).toBe(false);
    },
  );

  it.each([["messageId"], ["message_id"], ["contextId"], ["textureId"], ["bodyguard"]])(
    "keeps the identifier %s, which only resembles a correspondence name",
    (name) => {
      expect(panelRefSchema.safeParse({ provider: "telegram", params: { [name]: 42 } }).success).toBe(true);
    },
  );

  it.each([
    ["a meeting link with a passcode", "https://zoom.example/j/123?pwd=abc"],
    ["a link with a later password parameter", "https://host.example/open?room=1&password=abc"],
    ["a link with a token", "https://host.example/open?token=abc"],
    ["a link with a signature in the fragment", "https://host.example/open#access_token=abc"],
    ["a link with user credentials", "ssh://root:hunter2@host.example"],
    ["a link with a user name before the host", "https://user@host.example/path"],
  ])("rejects %s", (_name, url) => {
    expect(panelRefSchema.safeParse({ provider: "zoom", params: { url } }).success).toBe(false);
  });

  it("accepts a link without credentials", () => {
    expect(
      panelRefSchema.safeParse({ provider: "iframe", params: { url: "https://host.example/open?room=1" } }).success,
    ).toBe(true);
  });

  it("rejects a value too long to be an identifier", () => {
    expect(panelRefSchema.safeParse({ provider: "telegram", params: { chatId: "x".repeat(513) } }).success).toBe(false);
    expect(panelRefSchema.safeParse({ provider: "telegram", params: { chatId: "x".repeat(512) } }).success).toBe(true);
  });

  it("rejects a multi-line value", () => {
    expect(panelRefSchema.safeParse({ provider: "telegram", params: { chatId: "a\nb" } }).success).toBe(false);
  });
});

describe("panelRefKey", () => {
  it("is the same for parameters listed in a different order", () => {
    const first = panelRefKey({ provider: "diff-review", params: { threadId: "thr_a", target: "branch" } });
    const second = panelRefKey({ provider: "diff-review", params: { target: "branch", threadId: "thr_a" } });
    expect(first).toBe(second);
  });

  it.each([
    ["another provider", { provider: "bb-thread", params: { id: "1" } }, { provider: "terminals", params: { id: "1" } }],
    ["another value", { provider: "bb-thread", params: { id: "1" } }, { provider: "bb-thread", params: { id: "2" } }],
    ["another type of value", { provider: "bb-thread", params: { id: "1" } }, { provider: "bb-thread", params: { id: 1 } }],
    ["another name", { provider: "bb-thread", params: { id: "1" } }, { provider: "bb-thread", params: { key: "1" } }],
    [
      "a value moved between names",
      { provider: "bb-thread", params: { a: "b", c: "" } },
      { provider: "bb-thread", params: { a: "", c: "b" } },
    ],
  ])("differs for %s", (_name, first, second) => {
    expect(panelRefKey(first)).not.toBe(panelRefKey(second));
  });
});
