import { describe, expect, it } from "vitest";
import { createConsent } from "../src/core/consent.ts";
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

describe("embedded-mode consent", () => {
  it("is off until granted, off again after withdrawal, and tells subscribers once per change", () => {
    const consent = createConsent();
    let notified = 0;
    const unsubscribe = consent.subscribe(() => (notified += 1));

    expect(consent.granted()).toBe(false);
    consent.grant();
    consent.grant();
    expect(consent.granted()).toBe(true);
    consent.withdraw();
    expect(consent.granted()).toBe(false);
    expect(notified).toBe(2);

    unsubscribe();
    consent.grant();
    expect(notified).toBe(2);
  });

  it("starts off in every new instance: nothing is stored", () => {
    createConsent().grant();

    expect(createConsent().granted()).toBe(false);
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

  it("reserves one transfer at a time and drops only the text that was sent", () => {
    const staging = createStaging();
    staging.stage({ text: "first", source: { kind: "manual" } });

    expect(staging.beginTransfer()).toBe(true);
    expect(staging.beginTransfer()).toBe(false);
    expect(staging.transferring()).toBe(true);
    staging.stage({ text: "picked meanwhile", source: { kind: "manual" } });
    staging.endTransfer("first", true);

    expect(staging.transferring()).toBe(false);
    expect(staging.get()?.text).toBe("picked meanwhile");
    expect(staging.beginTransfer()).toBe(true);
    staging.endTransfer("picked meanwhile", false);
    expect(staging.get()?.text).toBe("picked meanwhile");
    expect(staging.beginTransfer()).toBe(true);
    staging.endTransfer("picked meanwhile", true);
    expect(staging.get()).toBeNull();
  });
});
