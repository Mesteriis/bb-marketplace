import { describe, expect, it } from "vitest";
import { GMAIL_SYSTEM_LABELS, LABEL_NAME_MAX, labelDeltas, ownerLabels, parseGmLabels, validLabelName } from "./labels.ts";

describe("parseGmLabels", () => {
  it("reads a JSON array of strings, deduplicated", () => {
    expect(parseGmLabels('["\\\\Inbox","Receipts","Receipts","Work/Plans"]')).toEqual(["\\Inbox", "Receipts", "Work/Plans"]);
  });

  it("answers nothing for NULL, bad JSON and non-strings", () => {
    expect(parseGmLabels(null)).toEqual([]);
    expect(parseGmLabels("{")).toEqual([]);
    expect(parseGmLabels('{"a":1}')).toEqual([]);
    expect(parseGmLabels('["ok", 3, null, ""]')).toEqual(["ok"]);
  });
});

describe("ownerLabels", () => {
  it("leaves system labels out", () => {
    expect(ownerLabels(["\\Inbox", "\\Important", "\\Starred", "Receipts", "[Gmail]/Sent Mail", "Work"])).toEqual([
      "Receipts",
      "Work",
    ]);
  });

  it("lists the system labels", () => {
    expect(GMAIL_SYSTEM_LABELS).toContain("\\Inbox");
    expect(GMAIL_SYSTEM_LABELS).toContain("\\Starred");
  });
});

describe("validLabelName", () => {
  it("accepts an owner label, trimmed", () => {
    expect(validLabelName("  Receipts 2026 ")).toEqual({ ok: true, name: "Receipts 2026" });
    expect(validLabelName("Work/Plans")).toEqual({ ok: true, name: "Work/Plans" });
  });

  it("refuses empty, too long, control characters, system labels and a leading backslash", () => {
    expect(validLabelName("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validLabelName("a".repeat(LABEL_NAME_MAX + 1))).toEqual({ ok: false, reason: "too_long" });
    expect(validLabelName("a".repeat(LABEL_NAME_MAX))).toEqual({ ok: true, name: "a".repeat(100) });
    expect(validLabelName("bad\u0007name")).toEqual({ ok: false, reason: "control" });
    expect(validLabelName("\\Custom")).toEqual({ ok: false, reason: "system" });
    expect(validLabelName("inbox")).toEqual({ ok: false, reason: "system" });
    expect(validLabelName("Starred")).toEqual({ ok: false, reason: "system" });
    expect(validLabelName("[Gmail]/Mine")).toEqual({ ok: false, reason: "system" });
  });
});

describe("labelDeltas", () => {
  const before = new Map([
    ["m1", ["Receipts"]],
    ["m2", ["Work"]],
    ["m3", []],
  ]);

  it("keeps only labels that really change", () => {
    expect(labelDeltas(before, ["Receipts"], ["Work"])).toEqual([
      { messageId: "m2", added: ["Receipts"], removed: ["Work"] },
      { messageId: "m3", added: ["Receipts"], removed: [] },
    ]);
  });

  it("skips labels already present or already absent", () => {
    expect(labelDeltas(new Map([["m1", ["A"]]]), ["A"], ["B"])).toEqual([]);
  });

  it("ignores a label both added and removed", () => {
    expect(labelDeltas(new Map([["m1", []]]), ["A", "B"], ["A"])).toEqual([{ messageId: "m1", added: ["B"], removed: [] }]);
  });
});
