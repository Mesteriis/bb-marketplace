// Host-free reassembly of a chunked screenshot (stage 2b-2, B7 + R2).
//
// The helper answers `rdp.screenshot` either with the whole base64 PNG in `png`,
// or with an empty `png`, `chunks: N` and N `rdp.screenshot_chunk` frames. The
// helper's own stream is validated by the helper; this class validates again
// because it is the last line before the RPC answer: order, count, per-chunk and
// total size, whole base64 quanta.
export const SCREENSHOT_CHUNK_BASE64_MAX = 786_432;
export const SCREENSHOT_CHUNKS_MAX = 64;

export interface ScreenshotHeader {
  id: number;
  frameId: number;
  width: number;
  height: number;
  timestamp: number;
  chunks: number;
}

export interface ScreenshotResult {
  frameId: number;
  width: number;
  height: number;
  timestamp: number;
  /** Base64 of the PNG. */
  png: string;
}

export type ChunkResult =
  | { status: "more" }
  | { status: "done"; result: ScreenshotResult }
  | { status: "error"; code: "bad_chunk" };

export class ScreenshotAssembler {
  private readonly parts: string[] = [];
  private next = 0;

  constructor(private readonly header: ScreenshotHeader) {}

  get requestId(): number {
    return this.header.id;
  }

  static valid(header: ScreenshotHeader): boolean {
    return header.chunks >= 2 && header.chunks <= SCREENSHOT_CHUNKS_MAX;
  }

  add(chunk: { id: number; index: number; count: number; data: string }): ChunkResult {
    if (
      chunk.id !== this.header.id ||
      chunk.index !== this.next ||
      chunk.count !== this.header.chunks ||
      chunk.data.length === 0 ||
      chunk.data.length > SCREENSHOT_CHUNK_BASE64_MAX ||
      chunk.data.length % 4 !== 0
    ) {
      return { status: "error", code: "bad_chunk" };
    }
    this.parts.push(chunk.data);
    this.next += 1;
    if (this.next < this.header.chunks) return { status: "more" };
    const { frameId, width, height, timestamp } = this.header;
    return { status: "done", result: { frameId, width, height, timestamp, png: this.parts.join("") } };
  }
}
