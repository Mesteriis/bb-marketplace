// openpgp's own types import these from an optional peer package Mail does
// not install (it never streams). The shapes here are enough to typecheck.
declare module "@openpgp/web-stream-tools" {
  export type WebStream<T> = ReadableStream<T>;
  export type NodeWebStream<T> = ReadableStream<T>;
}
