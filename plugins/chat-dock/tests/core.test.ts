import { describe, expect, it } from "vitest";
import { CONSENT_KEY, createConsent, type ConsentStorage } from "../src/core/consent.ts";
import { createStaging } from "../src/core/staging.ts";
import { describeTarget, isChatGptUrl, targetFromUrl } from "../src/core/target.ts";

function memoryStorage(): ConsentStorage & { data: Map<string, string>; fireExternal(): void; watchers(): number } {
  const data = new Map<string, string>();
  const watchers = new Set<() => void>();
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
    onExternalChange(listener) {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
    fireExternal: () => watchers.forEach((watcher) => watcher()),
    watchers: () => watchers.size,
  };
}

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
  it("is off until granted and off again after withdrawal", () => {
    const storage = memoryStorage();
    const consent = createConsent(storage);

    expect(consent.granted()).toBe(false);
    consent.grant();
    expect(consent.granted()).toBe(true);
    expect(storage.data.get(CONSENT_KEY)).toBe("granted");
    consent.withdraw();
    expect(consent.granted()).toBe(false);
    expect(storage.data.has(CONSENT_KEY)).toBe(false);
  });

  it("follows another window while subscribed and stops watching after", () => {
    const storage = memoryStorage();
    const consent = createConsent(storage);
    let notified = 0;
    expect(storage.watchers()).toBe(0);
    const unsubscribe = consent.subscribe(() => (notified += 1));
    expect(storage.watchers()).toBe(1);

    storage.data.set(CONSENT_KEY, "granted");
    storage.fireExternal();
    expect(consent.granted()).toBe(true);
    expect(notified).toBe(1);

    unsubscribe();
    expect(storage.watchers()).toBe(0);
    storage.fireExternal();
    expect(notified).toBe(1);
  });

  it("stays off when storage throws", () => {
    const consent = createConsent({
      get: () => {
        throw new Error("blocked");
      },
      set: () => {
        throw new Error("blocked");
      },
      remove: () => {},
      onExternalChange: () => () => {},
    });

    consent.grant();

    expect(consent.granted()).toBe(false);
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
});
