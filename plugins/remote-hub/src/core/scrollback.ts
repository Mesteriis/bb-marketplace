// Host-free bounded scrollback: a byte ring buffer that keeps the last N
// bytes of a session's output for re-attach snapshots.
export interface ScrollbackRead {
  start: number;
  end: number;
  bytes: Uint8Array;
  /** Bytes between the requested offset and `start` were already dropped. */
  gap: boolean;
}

export class Scrollback {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  /** Every byte ever appended: a read position that stays valid while old bytes fall off. */
  private total = 0;
  constructor(private readonly maxBytes: number) {}

  append(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    this.chunks.push(data);
    this.bytes += data.byteLength;
    this.total += data.byteLength;
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

  /** Offset one past the newest byte. */
  get endOffset(): number {
    return this.total;
  }

  /** Offset of the oldest byte still kept. */
  get startOffset(): number {
    return this.total - this.bytes;
  }

  /**
   * Up to `max` bytes from `from`. A `from` that was already dropped starts at the oldest kept byte and is
   * reported as a gap; one beyond the end reads nothing. `end` is where the next read should start.
   */
  read(from: number, max: number): ScrollbackRead {
    const oldest = this.startOffset;
    const gap = from < oldest;
    const start = Math.min(Math.max(from, oldest), this.total);
    const all = this.snapshot();
    const slice = all.subarray(start - oldest, Math.min(start - oldest + Math.max(0, max), all.byteLength));
    return { start, end: start + slice.byteLength, bytes: slice, gap };
  }

  /** The newest `max` bytes. */
  tail(max: number): ScrollbackRead {
    return this.read(Math.max(this.startOffset, this.total - Math.max(0, max)), max);
  }
}

export const SCROLLBACK_MAX_BYTES = 1024 * 1024; // 1 MiB
