// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PdfUnavailable } from "../../ui/pdf-view.tsx";
import {
  ANNOTATION_MODE_DISABLE,
  CANVAS_PIXELS_MAX,
  createPdfEngine,
  PDF_OPTIONS,
  PDFJS_LICENSE,
  probeWorker,
  type PdfLib,
  type PdfPageDeps,
} from "./pdf-page.ts";

/** A worker that answers (or fails, or stays silent) as told. */
function fakeWorker(mode: "ready" | "error" | "silent") {
  const target = new EventTarget() as EventTarget & { terminate: () => void };
  target.terminate = vi.fn();
  if (mode !== "silent") {
    setTimeout(() => target.dispatchEvent(mode === "ready" ? new MessageEvent("message", { data: "ready" }) : new Event("error")), 0);
  }
  return target as unknown as Worker;
}

function fakeLib() {
  const calls = { getDocument: [] as Record<string, unknown>[], render: [] as Record<string, unknown>[], workers: [] as unknown[] };
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
    render: (params: Record<string, unknown>) => {
      calls.render.push(params);
      return { promise: Promise.resolve(), cancel: () => {} };
    },
    getAnnotations: async () => [
      { subtype: "Link", url: "https://example.org/a" },
      { subtype: "Link", unsafeUrl: "javascript:alert(1)" },
      { subtype: "Widget", url: "https://example.org/form" },
    ],
    cleanup: () => {},
  };
  const lib: PdfLib = {
    PDFWorker: class {
      constructor(params: { port: Worker }) {
        calls.workers.push(params.port);
      }
      destroy() {}
    } as unknown as PdfLib["PDFWorker"],
    getDocument: (params) => {
      calls.getDocument.push(params);
      return { promise: Promise.resolve({ numPages: 3, getPage: async () => page }), destroy: async () => {} };
    },
  };
  return { lib, calls };
}

function deps(mode: "ready" | "error" | "silent", lib: PdfLib): PdfPageDeps & { loadLib: ReturnType<typeof vi.fn> } {
  return {
    workerSource: async () => "/* worker */",
    loadLib: vi.fn(async () => lib),
    createWorker: () => fakeWorker(mode),
    createObjectUrl: () => "blob:worker",
    revokeObjectUrl: vi.fn(),
    probeMs: 50,
  };
}

describe("pdf-page engine", () => {
  it("opens bytes with the locked-down options and the probed worker", async () => {
    const { lib, calls } = fakeLib();
    const engine = createPdfEngine(deps("ready", lib));
    const doc = await engine.open(new Uint8Array([37, 80, 68, 70]));
    expect(doc.pages).toBe(3);
    const params = calls.getDocument[0]!;
    expect(params).toMatchObject(PDF_OPTIONS);
    expect(PDF_OPTIONS).toEqual({ isEvalSupported: false, disableAutoFetch: true, disableStream: true, enableXfa: false, useSystemFonts: false });
    for (const key of ["cMapUrl", "standardFontDataUrl", "wasmUrl", "url"]) expect(params).not.toHaveProperty(key);
    expect(params.data).toBeInstanceOf(Uint8Array);
    expect(calls.workers).toHaveLength(1);
    expect(engine.license).toBe(PDFJS_LICENSE);
  });

  it("renders with annotations off and lists Link URLs", async () => {
    const { lib, calls } = fakeLib();
    const doc = await createPdfEngine(deps("ready", lib)).open(new Uint8Array([1]));
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => ({})) as unknown as HTMLCanvasElement["getContext"];
    await doc.render(1, canvas, 2);
    expect(calls.render[0]).toMatchObject({ annotationMode: ANNOTATION_MODE_DISABLE });
    expect(canvas.width).toBe(200);
    expect(await doc.links(1)).toEqual(["https://example.org/a", "javascript:alert(1)"]);
  });

  it("cancels the previous render on the canvas before starting another; the cancelled one resolves quietly", async () => {
    const { lib } = fakeLib();
    const tasks: { cancelled: boolean; finish: () => void }[] = [];
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
      render: () => {
        let reject!: (error: Error) => void;
        let resolve!: () => void;
        const promise = new Promise<void>((ok, fail) => {
          resolve = ok;
          reject = fail;
        });
        const task = {
          cancelled: false,
          finish: () => resolve(),
        };
        tasks.push(task);
        return {
          promise,
          cancel: () => {
            task.cancelled = true;
            reject(Object.assign(new Error("Rendering cancelled"), { name: "RenderingCancelledException" }));
          },
        };
      },
      getAnnotations: async () => [],
      cleanup: () => {},
    };
    lib.getDocument = () => ({ promise: Promise.resolve({ numPages: 2, getPage: async () => page }), destroy: async () => {} });
    const doc = await createPdfEngine(deps("ready", lib)).open(new Uint8Array([1]));
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => ({})) as unknown as HTMLCanvasElement["getContext"];
    const first = doc.render(1, canvas, 1);
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    const second = doc.render(2, canvas, 1);
    await expect(first).resolves.toBeUndefined();
    await vi.waitFor(() => expect(tasks).toHaveLength(2));
    expect(tasks[0]!.cancelled).toBe(true);
    tasks[1]!.finish();
    await expect(second).resolves.toBeUndefined();
    expect(tasks[1]!.cancelled).toBe(false);
  });

  it("caps the canvas at about 16 megapixels by lowering the scale", async () => {
    const { lib } = fakeLib();
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 2_000 * scale, height: 4_000 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      getAnnotations: async () => [],
      cleanup: () => {},
    };
    lib.getDocument = () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: async () => {} });
    const doc = await createPdfEngine(deps("ready", lib)).open(new Uint8Array([1]));
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => ({})) as unknown as HTMLCanvasElement["getContext"];
    await doc.render(1, canvas, 4);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(CANVAS_PIXELS_MAX);
    expect(canvas.width * canvas.height).toBeGreaterThan(CANVAS_PIXELS_MAX * 0.99);
    expect(canvas.height / canvas.width).toBeCloseTo(2, 2);
  });

  it.each(["error", "silent"] as const)("a worker that %s is download-only and pdf.js is never loaded", async (mode) => {
    const { lib, calls } = fakeLib();
    const d = deps(mode, lib);
    await expect(createPdfEngine(d).open(new Uint8Array([1]))).rejects.toBeInstanceOf(PdfUnavailable);
    expect(d.loadLib).not.toHaveBeenCalled();
    expect(calls.getDocument).toHaveLength(0);
  });

  it("a page that refuses the worker is download-only", async () => {
    const { lib } = fakeLib();
    const d = { ...deps("ready", lib), createWorker: () => {
      throw new Error("refused by the page");
    } };
    await expect(createPdfEngine(d).open(new Uint8Array([1]))).rejects.toBeInstanceOf(PdfUnavailable);
  });

  it("probes for the first message", async () => {
    await expect(probeWorker(fakeWorker("ready"), 50)).resolves.toBeUndefined();
    await expect(probeWorker(fakeWorker("silent"), 10)).rejects.toBeInstanceOf(PdfUnavailable);
  });
});
