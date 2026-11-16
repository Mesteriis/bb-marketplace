// Server-side PDF text for attachment search (slice 3h, #84; spec
// resolution 1, Task 0 result). pdf.js never runs on the plugin server's
// own thread: each PDF goes to a fresh `worker_threads` worker with heap
// limits, a timer that terminates it, and nothing but the bytes.
//
// - The worker's source is the string below, started with `eval: true`, so
//   the one bundled dist/server.js carries it. The parent resolves pdf.js
//   (`legacy/build/pdf.mjs` and its `pdf.worker.mjs`) from the plugin's own
//   node_modules and passes `file:` URLs; pdf.js then runs its own "fake
//   worker" inside this worker thread.
// - pdf.js tries to load the native canvas package on import. A resolve hook
//   refuses it (the pattern is written `napi[-]rs` so the bundle never holds
//   the package name), and minimal DOMMatrix / Path2D stubs stand in.
// - Options: data bytes only, no eval, no font face, no system fonts, no
//   standard font or CMap URL, no XFA. At most `maxPages` pages.
// - The worker's stdout and stderr are drained: pdf.js prints warnings, and
//   nothing from a PDF may reach the plugin log.
// - Known limit (Task 0): `resourceLimits` bounds the V8 heap, not buffer
//   memory. The 5 MB PDF cap (ATTACHMENT_TEXT_CAPS.pdfFile), one worker at a
//   time (the indexer) and the timer bound it.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker, type ResourceLimits } from "node:worker_threads";
import { ATTACHMENT_TEXT_CAPS } from "../../core/attachment-text.ts";

export type PdfTextResult =
  | { text: string }
  | { skipped: "encrypted" }
  | { failed: "timeout" | "unreadable" };

export type PdfTextOptions = {
  timeoutMs?: number;
  maxPages?: number;
  /** Tests only: other worker limits and source. */
  resourceLimits?: ResourceLimits;
  workerSource?: string;
};

export const PDF_TIMEOUT_MS = 20_000;
export const PDF_MAX_PAGES = 200;

export const PDF_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

/**
 * The worker. CommonJS (an eval worker); it imports pdf.js by the URLs in
 * workerData, extracts each page's text items and posts one result.
 */
export const PDF_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const nodeModule = require("node:module");
const BLOCKED = /^@napi[-]rs\//;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (BLOCKED.test(specifier)) throw new Error("blocked");
    return nextResolve(specifier, context);
  },
});
if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
  };
}
if (typeof globalThis.Path2D === "undefined") {
  globalThis.Path2D = class Path2D {};
}
(async () => {
  const { pdfUrl, workerUrl, maxPages, maxChars } = workerData;
  let task = null;
  let result;
  try {
    const pdfjs = await import(pdfUrl);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    task = pdfjs.getDocument({
      data: new Uint8Array(workerData.bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    const pages = Math.min(doc.numPages, maxPages);
    let text = "";
    for (let n = 1; n <= pages && text.length < maxChars; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        text += item.str + (item.hasEOL ? "\n" : " ");
      }
      text += "\n";
      page.cleanup();
    }
    result = { text: text.slice(0, maxChars * 2) };
  } catch (error) {
    result = error && error.name === "PasswordException" ? { skipped: "encrypted" } : { failed: "unreadable" };
  }
  try {
    if (task !== null) await task.destroy();
  } catch {}
  parentPort.postMessage(result);
})();
`;

let resolved: { pdfUrl: string; workerUrl: string } | null = null;

/** pdf.js from the plugin's own node_modules, as file: URLs. */
function pdfjsUrls(): { pdfUrl: string; workerUrl: string } {
  if (resolved === null) {
    const require = createRequire(import.meta.url);
    resolved = {
      pdfUrl: pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href,
      workerUrl: pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href,
    };
  }
  return resolved;
}

/** Whitespace runs collapsed, control characters removed, at most ATTACHMENT_TEXT_CAPS.chars. */
function cleanText(raw: string): string {
  const text = raw
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g, "")
    .replace(/[\s\u0085]+/g, " ")
    .trim();
  return Array.from(text).slice(0, ATTACHMENT_TEXT_CAPS.chars).join("");
}

function asResult(value: unknown): PdfTextResult {
  if (typeof value !== "object" || value === null) return { failed: "unreadable" };
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return { text: cleanText(record.text) };
  if (record.skipped === "encrypted") return { skipped: "encrypted" };
  return { failed: "unreadable" };
}

/**
 * The text of one PDF, from a fresh worker. An error, an out-of-memory end
 * or any other exit is `unreadable`; the timer terminates the worker and
 * answers `timeout`. Never throws.
 */
export function extractPdfText(bytes: Uint8Array, options: PdfTextOptions = {}): Promise<PdfTextResult> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PdfTextResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker?.terminate().catch(() => undefined);
      resolve(result);
    };
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const source = options.workerSource ?? PDF_WORKER_SOURCE;
      worker = new Worker(source, {
        eval: true,
        resourceLimits: options.resourceLimits ?? PDF_RESOURCE_LIMITS,
        stdout: true,
        stderr: true,
        workerData: {
          ...pdfjsUrls(),
          bytes: copy.buffer,
          maxPages: options.maxPages ?? PDF_MAX_PAGES,
          maxChars: ATTACHMENT_TEXT_CAPS.chars,
        },
        transferList: [copy.buffer],
      });
    } catch {
      resolve({ failed: "unreadable" });
      return;
    }
    // Nothing a PDF makes pdf.js print reaches the plugin's log.
    worker.stdout.resume();
    worker.stderr.resume();
    timer = setTimeout(() => finish({ failed: "timeout" }), options.timeoutMs ?? PDF_TIMEOUT_MS);
    worker.once("message", (message: unknown) => finish(asResult(message)));
    worker.once("error", () => finish({ failed: "unreadable" }));
    worker.once("exit", () => finish({ failed: "unreadable" }));
  });
}
