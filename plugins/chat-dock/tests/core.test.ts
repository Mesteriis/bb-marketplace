import { describe, expect, it } from "vitest";
import { createStaging } from "../src/core/staging.ts";
import { describeTarget, isChatGptUrl, targetFromUrl } from "../src/core/target.ts";

describe("conversation targets", () => {
  it("accepts a conversation and a project conversation", () => {
    expect(targetFromUrl("https://chatgpt.com/c/0123abcd-ef")).toEqual({
      ok: true,
      target: { origin: "https://chatgpt.com", path: "/c/0123abcd-ef" },
    });
    expect(targetFromUrl("https://chatgpt.com/g/g-p-42/c/0123abcd-ef?model=x#frag")).toEqual({
      ok: true,
      target: { origin: "https://chatgpt.com", path: "/g/g-p-42/c/0123abcd-ef" },
    });
  });

  it("refuses a look-alike host, a port and a nested path", () => {
    expect(targetFromUrl("https://chatgpt.com:8443/c/0123abcd-ef")).toEqual({ ok: false, reason: "not-chatgpt" });
    expect(targetFromUrl("https://www.chatgpt.com/c/0123abcd-ef")).toEqual({ ok: false, reason: "not-chatgpt" });
    expect(targetFromUrl("https://chatgpt.com/c/0123abcd-ef/extra")).toEqual({ ok: false, reason: "no-conversation" });
  });

  it("tells ChatGPT pages from other sites", () => {
    expect(isChatGptUrl("https://chatgpt.com/")).toBe(true);
    expect(isChatGptUrl("https://example.com/c/0123abcd-ef")).toBe(false);
  });

  it("labels a conversation by the end of its id", () => {
    expect(describeTarget({ origin: "https://chatgpt.com", path: "/c/aaaaaaaa-0000-4000-8000-00000000000a" })).toBe(
      "беседа …0000000a",
    );
  });
});

describe("staged context", () => {
  it("keeps the source through an edit and forgets everything on clear", () => {
    const staging = createStaging();
    staging.stage({ text: "picked", source: { kind: "message-selection", threadId: "thr_1" } });
    staging.edit("picked and trimmed");

    expect(staging.get()).toEqual({
      text: "picked and trimmed",
      source: { kind: "message-selection", threadId: "thr_1" },
    });
    staging.clear();
    expect(staging.get()).toBeNull();
  });

  it("names typed text as manual input", () => {
    const staging = createStaging();
    staging.edit("typed");

    expect(staging.get()).toEqual({ text: "typed", source: { kind: "manual" } });
  });

  it("drops the staged text only when it is still exactly the sent text", () => {
    const staging = createStaging();
    staging.stage({ text: "sent", source: { kind: "manual" } });
    staging.clearIf("other");
    expect(staging.get()?.text).toBe("sent");
    staging.edit("edited meanwhile");
    staging.clearIf("sent");
    expect(staging.get()?.text).toBe("edited meanwhile");
    staging.clearIf("edited meanwhile");
    expect(staging.get()).toBeNull();
  });
});
