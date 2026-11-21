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

  it.each([
    ["an encoded letter in the parameter name", "https://zoom.example/j/123?p%77d=abc"],
    ["a fully encoded parameter name", "https://zoom.example/j/123?%70%77%64=abc"],
    ["a twice-encoded parameter name", "https://zoom.example/j/123?p%2577d=abc"],
    ["a three-times-encoded parameter name", "https://zoom.example/j/123?p%252577d=abc"],
    ["an encoded separator before the name", "https://zoom.example/j/123?room=1%26pwd=abc"],
    ["an encoded equals sign", "https://zoom.example/j/123?pwd%3Dabc"],
    ["a whole encoded link in a value", "https://host.example/go?next=https%3A%2F%2Fzoom.example%2Fj%2F1%3Fpwd%3Dabc"],
    ["a twice-encoded link in a value", "https://host.example/go?next=https%253A%252F%252Fz.example%252Fj%253Fpwd%253Dabc"],
    ["an encoded short token name", "https://zoom.example/j/123?t%6b=abc"],
    ["a padded parameter name", "https://zoom.example/j/123?%20tk=abc"],
    ["encoded user credentials", "ssh:%2F%2Froot:hunter2%40host.example"],
    ["an encoded at sign after credentials", "ssh://root:hunter2%40host.example"],
    ["encoding nested too deep to check", "https://z.example/?p%2525252525252577d=abc"],
  ])("rejects a link with %s", (_name, url) => {
    expect(panelRefSchema.safeParse({ provider: "zoom", params: { url } }).success).toBe(false);
  });

  it.each([
    ["written plainly in a parameter", "https://host.example/go?next=https://user:pass@inner.example/x"],
    ["encoded once", "https://host.example/go?next=https%3A%2F%2Fuser%3Apass%40inner.example%2Fx"],
    ["encoded twice", "https://host.example/go?next=https%253A%252F%252Fuser%253Apass%2540inner.example%252Fx"],
    ["with only a user name, encoded once", "https://host.example/go?next=https%3A%2F%2Fuser%40inner.example"],
    ["in the fragment", "https://host.example/go#https://user:pass@inner.example"],
    ["in the path", "https://host.example/redirect/ssh://root:hunter2@inner.example"],
    ["without a scheme", "https://host.example/go?next=//user:pass@inner.example/x"],
    ["without a scheme, encoded once", "https://host.example/go?next=%2F%2Fuser%3Apass%40inner.example"],
    ["with backslashes for slashes", "https://host.example/go?next=https:\\\\user:pass@inner.example"],
    ["after text that is not a link", "see:ssh://root:hunter2@inner.example"],
  ])("rejects user credentials in a nested link %s", (_name, url) => {
    expect(panelRefSchema.safeParse({ provider: "iframe", params: { url } }).success).toBe(false);
  });

  it.each([
    ["an at sign in a parameter value", "https://host.example/open?contact=team@host.example"],
    ["an at sign in the path", "https://host.example/users/@team/rooms"],
    ["a nested link without credentials", "https://host.example/go?next=https%3A%2F%2Finner.example%2Fx"],
    ["a doubled slash in the path", "https://host.example/a//b"],
  ])("accepts a link with %s", (_name, url) => {
    expect(panelRefSchema.safeParse({ provider: "iframe", params: { url } }).success).toBe(true);
  });

  it.each([["p%77d"], ["a.b"], ["a b"], ["1st"], ["тема"]])("rejects the parameter name %s, which is not a plain identifier", (name) => {
    expect(panelRefSchema.safeParse({ provider: "zoom", params: { [name]: "x" } }).success).toBe(false);
  });

  it("accepts a link with harmless encoded characters", () => {
    expect(
      panelRefSchema.safeParse({ provider: "iframe", params: { url: "https://host.example/open?room=a%2Fb&name=100%25" } })
        .success,
    ).toBe(true);
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

  it.each([
    ["a sentence", "see you at five"],
    ["a tab-separated value", "a\tb"],
    ["a non-breaking space", "a\u00a0b"],
    ["a leading space", " thr_a"],
  ])("rejects %s as a value, since identifiers have no whitespace", (_name, value) => {
    expect(panelRefSchema.safeParse({ provider: "bb-thread", params: { threadId: "thr_a", note: value } }).success).toBe(
      false,
    );
  });

  it("accepts a path whose spaces are percent-encoded", () => {
    expect(panelRefSchema.safeParse({ provider: "markdown-editor", params: { path: "docs/My%20Notes.md" } }).success).toBe(
      true,
    );
  });

  it("rejects more parameters than a reference needs", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const nine = Object.fromEntries(names.map((name) => [name, 1]));
    const eight = Object.fromEntries(names.slice(0, 8).map((name) => [name, 1]));
    expect(panelRefSchema.safeParse({ provider: "bb-thread", params: nine }).success).toBe(false);
    expect(panelRefSchema.safeParse({ provider: "bb-thread", params: eight }).success).toBe(true);
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
