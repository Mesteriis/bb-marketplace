// Host-free bounded scrollback: a byte ring buffer that keeps the last N
// bytes of a session's output for re-attach snapshots.
export class Scrollback {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}

  append(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    this.chunks.push(data);
    this.bytes += data.byteLength;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0];
      const excess = this.bytes - this.maxBytes;
      if (excess >= first.byteLength) {
        this.chunks.shift();
        this.bytes -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  get size(): number {
    return this.bytes;
  }
}

export const SCROLLBACK_MAX_BYTES = 1024 * 1024; // 1 MiB
