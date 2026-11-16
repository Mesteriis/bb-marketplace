import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RECEIPT_HEADERS, receiptRequested } from "./receipts.ts";

describe("receiptRequested", () => {
  it("detects each of the three headers, case-insensitively", () => {
    expect(RECEIPT_HEADERS).toHaveLength(3);
    for (const name of RECEIPT_HEADERS) {
      expect(receiptRequested([{ key: name, value: "a@example.com" }]), name).toBe(true);
      expect(receiptRequested([{ key: name.toLowerCase(), value: "a@example.com" }]), name).toBe(true);
      expect(receiptRequested([{ key: name.toUpperCase(), value: "" }]), name).toBe(true);
    }
  });

  it("is false without them", () => {
    expect(receiptRequested([])).toBe(false);
    expect(receiptRequested([{ key: "from", value: "a@example.com" }, { key: "x-confirm-reading", value: "a@example.com" }])).toBe(false);
  });
});

describe("Mail never sends or asks for a read receipt (part A resolution 19)", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const files = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return files(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it("names the receipt headers and MDN reports only in receipts.ts and its test", () => {
    const pattern = /disposition-notification|return-receipt-to|x-confirm-reading-to/i;
    const hits = [...files(join(root, "src")), join(root, "server.ts"), join(root, "app.tsx")]
      .filter((path) => pattern.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path).split("\\").join("/"))
      .sort();
    expect(hits).toEqual(["src/core/receipts.test.ts", "src/core/receipts.ts"]);
  });
});
