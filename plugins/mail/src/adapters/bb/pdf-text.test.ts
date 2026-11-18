import { describe, expect, it } from "vitest";
import { extractPdfText, PDF_WORKER_SOURCE } from "./pdf-text.ts";
import { buildPdf, buildEncryptedPdf } from "./fixtures/pdf.ts";

describe("extractPdfText", () => {
  it("extracts the text a hand-written PDF draws inside its pages", async () => {
    const pdf = buildPdf(["Invoice INV-2041 for example.org", "Second page made-up text"]);
    const result = await extractPdfText(pdf, { timeoutMs: 15_000 });
    expect(result).toEqual({ text: expect.stringContaining("Invoice INV-2041 for example.org") });
    expect("text" in result && result.text).toContain("Second page made-up text");
  });

  it("stops at maxPages", async () => {
    const pdf = buildPdf(["First invented page", "Second invented page"]);
    const result = await extractPdfText(pdf, { timeoutMs: 15_000, maxPages: 1 });
    expect("text" in result && result.text).toContain("First invented page");
    expect("text" in result && result.text).not.toContain("Second invented page");
  });

  it("skips an encrypted PDF", async () => {
    const result = await extractPdfText(buildEncryptedPdf("Locked invented text"), { timeoutMs: 15_000 });
    expect(result).toEqual({ skipped: "encrypted" });
  });

  it("answers unreadable for bytes that are not a PDF", async () => {
    const result = await extractPdfText(new TextEncoder().encode("not a pdf at all"), { timeoutMs: 15_000 });
    expect(result).toEqual({ failed: "unreadable" });
  });

  it("terminates a worker that never answers at the bound", async () => {
    const started = Date.now();
    const result = await extractPdfText(new Uint8Array(4), { timeoutMs: 300, workerSource: "for (;;) {}" });
    expect(result).toEqual({ failed: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("an out-of-memory worker is unreadable and this process goes on", async () => {
    const bomb = "const keep = []; for (;;) keep.push(new Array(1e5).fill({ x: Math.random() }));";
    const result = await extractPdfText(new Uint8Array(4), {
      timeoutMs: 30_000,
      workerSource: bomb,
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
    });
    expect(result).toEqual({ failed: "unreadable" });
    expect(1 + 1).toBe(2);
  });

  it("nothing the worker prints reaches this process's output", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const result = await extractPdfText(new Uint8Array(4), {
        timeoutMs: 15_000,
        workerSource:
          'const { parentPort } = require("node:worker_threads"); console.log("canary-invented-line"); console.error("canary-invented-line"); parentPort.postMessage({ text: "ok" });',
      });
      expect(result).toEqual({ text: "ok" });
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }
    expect(written.join("")).not.toContain("canary-invented-line");
  });

  it("pdf.js loads no native module in the worker", async () => {
    const probe = PDF_WORKER_SOURCE.replace(
      "parentPort.postMessage(result);",
      'parentPort.postMessage({ text: "loaded:" + process.report.getReport().sharedObjects.filter((s) => /canvas|skia|napi/i.test(s)).length + " " + (result.text || "") });',
    );
    const result = await extractPdfText(buildPdf(["Probe invented text"]), { timeoutMs: 15_000, workerSource: probe });
    expect(result).toEqual({ text: expect.stringContaining("loaded:0 Probe invented text") });
  });

  it("the worker source never names the native canvas package", () => {
    expect(PDF_WORKER_SOURCE).not.toContain("napi-rs");
  });
});
