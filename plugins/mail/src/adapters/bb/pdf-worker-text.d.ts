// The worker bundle imported as text (pdf-worker-source.ts); esbuild's text loader.
declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  const source: string;
  export default source;
}
