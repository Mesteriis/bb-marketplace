import { describe, expect, it } from "vitest";
import {
  errorReasons, modelsInput, parseReason, provider, providerCatalog, reasonMessage,
} from "../src/core/contract";

describe("provider catalog", () => {
  it("drives the provider schema from one list", () => {
    expect(provider.options).toEqual(providerCatalog.map(({ id }) => id));
    expect(new Set(providerCatalog.map(({ id }) => id)).size).toBe(providerCatalog.length);
  });

  it("accepts models input with or without a project", () => {
    expect(modelsInput.parse({ providerId: "codex" })).toEqual({ providerId: "codex" });
    expect(() => modelsInput.parse({ providerId: "codex", projectId: "" })).toThrow();
  });
});

describe("error reasons", () => {
  it("round-trips every reason through the message prefix", () => {
    for (const reason of Object.keys(errorReasons) as (keyof typeof errorReasons)[]) {
      expect(parseReason(reasonMessage(reason, "Human text."))).toBe(reason);
    }
  });

  it("ignores messages without a known prefix", () => {
    expect(parseReason("Model stream does not exist.")).toBeUndefined();
    expect(parseReason("other_reason: text")).toBeUndefined();
  });
});
