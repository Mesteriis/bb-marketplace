// pdf.js's worker as text (slice 3h, Task 0 result): `bb plugin build`
// embeds it in dist/app.js as a string, and pdf-page.ts starts it from a
// blob: URL. Kept apart so tests can replace it without loading pdf.js.
import source from "pdfjs-dist/build/pdf.worker.min.mjs" with { type: "text" };

export const PDF_WORKER_SOURCE: string = source;
