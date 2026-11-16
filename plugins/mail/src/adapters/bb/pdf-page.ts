// The page-side PdfEngine (slice 3h, #50) over pdfjs-dist; only app.tsx
// imports it, and src/ui sees the PdfEngine port alone.
//
// Containment (spec resolution 2, Task 0 result):
// - pdf.js runs in a module worker started from a blob: URL of the embedded
//   worker source, never on BB's main thread. Before pdf.js gets the worker,
//   a start probe waits for its first message (or an error) with a short
//   timeout: under a CSP that refuses blob: workers, getDocument would hang
//   rather than reject. A failed probe means download-only.
// - getDocument gets bytes only: no cMapUrl, standardFontDataUrl or wasmUrl,
//   no eval, no XFA, no system fonts, no streaming or auto-fetch.
// - Pages render with annotations off; links are read from Link
//   annotations and filtered by the view.
// - pdf.js is imported lazily, so the library is evaluated only when a PDF
//   opens.
import type { PdfDocument, PdfEngine } from "../../ui/pdf-view.tsx";
import { PdfUnavailable } from "../../ui/pdf-view.tsx";

/**
 * pdf.js's license notice. `bb plugin build` drops legal comments, so the
 * bundle keeps it as this string (THIRD_PARTY_NOTICES.md, pdf.js).
 */
export const PDFJS_LICENSE =
  "pdf.js (pdfjs-dist 6.5.438). Copyright 2024 Mozilla Foundation. Licensed under the Apache License, Version 2.0 " +
  '(the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the ' +
  "License at http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in writing, " +
  'software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY ' +
  "KIND, either express or implied. See the License for the specific language governing permissions and limitations " +
  "under the License.";

/** How long the start probe waits for the worker's first message. */
export const PROBE_MS = 3_000;

/** The getDocument options apart from the bytes and the worker (asserted by tests). */
export const PDF_OPTIONS = {
  isEvalSupported: false,
  disableAutoFetch: true,
  disableStream: true,
  enableXfa: false,
  useSystemFonts: false,
} as const;

/** pdf.js's AnnotationMode.DISABLE. */
export const ANNOTATION_MODE_DISABLE = 0;

/** What this adapter uses of pdfjs-dist (a fake stands in for it in tests). */
export interface PdfLib {
  PDFWorker: new (params: { port: Worker }) => { destroy(): void };
  getDocument: (params: Record<string, unknown>) => {
    promise: Promise<PdfJsDocument>;
    destroy(): Promise<void>;
  };
}

interface PdfJsPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: Record<string, unknown>): { promise: Promise<void> };
  getAnnotations(): Promise<{ subtype?: string; url?: string; unsafeUrl?: string }[]>;
  cleanup(): void;
}

interface PdfJsDocument {
  numPages: number;
  getPage(n: number): Promise<PdfJsPage>;
}

export interface PdfPageDeps {
  workerSource: () => Promise<string>;
  loadLib: () => Promise<PdfLib>;
  /** Starts a module worker at a URL; throws when the page refuses it. */
  createWorker: (url: string) => Worker;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  probeMs?: number;
}

/**
 * Resolves the worker once it has said something (pdf.js posts as soon as
 * it starts); rejects on an error event or when the probe times out.
 */
export function probeWorker(worker: Worker, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (ok) resolve();
      else reject(new PdfUnavailable());
    };
    const onMessage = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), ms);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

/** Starts the embedded worker from a blob: URL and probes it; null when it cannot run here. */
async function startWorker(deps: PdfPageDeps): Promise<Worker | null> {
  let url: string | null = null;
  let worker: Worker | null = null;
  try {
    url = deps.createObjectUrl(new Blob([await deps.workerSource()], { type: "text/javascript" }));
    worker = deps.createWorker(url);
    await probeWorker(worker, deps.probeMs ?? PROBE_MS);
    return worker;
  } catch {
    worker?.terminate();
    return null;
  } finally {
    if (url !== null) deps.revokeObjectUrl(url);
  }
}

export function createPdfEngine(deps: PdfPageDeps): PdfEngine & { license: string } {
  return {
    // Referenced, so the bundle keeps pdf.js's notice.
    license: PDFJS_LICENSE,
    async open(bytes) {
      const worker = await startWorker(deps);
      // Never the main thread: no worker, no preview.
      if (worker === null) throw new PdfUnavailable();
      let lib: PdfLib;
      try {
        lib = await deps.loadLib();
      } catch {
        worker.terminate();
        throw new PdfUnavailable();
      }
      const pdfWorker = new lib.PDFWorker({ port: worker });
      // pdf.js takes the buffer; a copy keeps the viewer's bytes intact.
      const task = lib.getDocument({ data: bytes.slice(), worker: pdfWorker, ...PDF_OPTIONS });
      const close = () => {
        void task.destroy().catch(() => {});
        pdfWorker.destroy();
        worker.terminate();
      };
      let doc: PdfJsDocument;
      try {
        doc = await task.promise;
      } catch (error) {
        close();
        throw error;
      }
      const result: PdfDocument = {
        pages: doc.numPages,
        async render(n, canvas, scale) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const context = canvas.getContext("2d");
          if (context === null) throw new Error("No canvas");
          await page.render({ canvas, canvasContext: context, viewport, annotationMode: ANNOTATION_MODE_DISABLE }).promise;
        },
        async links(n) {
          const page = await doc.getPage(n);
          const annotations = await page.getAnnotations();
          return annotations
            .filter((a) => a.subtype === "Link")
            .map((a) => a.url ?? a.unsafeUrl)
            .filter((url): url is string => typeof url === "string");
        },
        close,
      };
      return result;
    },
  };
}

/** The engine over the real pdfjs-dist and the embedded worker, for app.tsx. */
export function browserPdfEngine(): PdfEngine | null {
  if (typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") return null;
  return createPdfEngine({
    workerSource: async () => (await import("./pdf-worker-source.ts")).PDF_WORKER_SOURCE,
    loadLib: async () => (await import("pdfjs-dist")) as unknown as PdfLib,
    createWorker: (url) => new Worker(url, { type: "module" }),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  });
}
