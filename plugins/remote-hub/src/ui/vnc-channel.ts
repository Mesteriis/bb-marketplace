// A WebSocket-shaped channel for noVNC (v1.6.0 `WebSock.attach`), fed from our own stream socket. noVNC checks that the
// object has `send close binaryType onerror onmessage onopen protocol readyState` (as own or prototype properties) and drives it
// like a browser WebSocket; the console's raw RFB bytes arrive through `deliver`, and what noVNC writes leaves through `out`.
// Host-free and noVNC-free: it only has to look like a WebSocket.
export type VncChannelState = "connecting" | "open" | "closing" | "closed";

export interface VncChannelMessage {
  data: ArrayBuffer;
}

export class VncChannel {
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  get protocol(): string {
    return "";
  }
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  private handler: ((event: VncChannelMessage) => void) | null = null;
  private state: VncChannelState = "connecting";
  /** Bytes that arrived before noVNC set `onmessage`; handed over in order as soon as it does. */
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private opened = false;
  private closeRequested = false;
  private overflowed = false;

  constructor(
    private readonly out: (bytes: Uint8Array) => void,
    /** noVNC called `close()`: the page tears the socket down. */
    private readonly onCloseRequested: () => void,
    private readonly limits: {
      /** Most bytes held for noVNC before it installs its handler; past it `onOverflow` fires once and nothing more is kept. */
      maxQueuedBytes: number;
      onOverflow: () => void;
      /** Bytes handed to noVNC (the credit that lets the service send more). */
      onConsumed: (bytes: number) => void;
    },
  ) {}

  get onmessage(): ((event: VncChannelMessage) => void) | null {
    return this.handler;
  }

  /** noVNC assigns this after the object was handed over: whatever waited is delivered at that moment, in order. */
  set onmessage(handler: ((event: VncChannelMessage) => void) | null) {
    this.handler = handler;
    // WebSock installs onmessage before RFB inspects readyState and starts its handshake.
    // A late viewer of an open socket handles open itself. Deliver the queued greeting after attach returns.
    if (handler && this.opened) queueMicrotask(() => this.flush());
  }

  get readyState(): VncChannelState {
    return this.state;
  }

  /** noVNC writes RFB bytes. Nothing is sent before the channel is open or after it closed. */
  send(data: Uint8Array | ArrayBuffer): void {
    if (this.state !== "open") return;
    this.out(data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0)));
  }

  close(): void {
    if (this.state === "closed" || this.closeRequested) return;
    this.closeRequested = true;
    this.state = "closing";
    this.onCloseRequested();
  }

  // ---- fed by the page ----

  /** The stream socket is open. */
  deliverOpen(): void {
    if (this.state !== "connecting") return;
    this.state = "open";
    this.opened = true;
    this.onopen?.();
    this.flush();
  }

  /** Raw RFB bytes from the console. */
  deliver(bytes: Uint8Array): void {
    if (this.state === "closed" || this.overflowed) return;
    if (this.queuedBytes + bytes.byteLength > this.limits.maxQueuedBytes && this.handler === null) {
      // The viewer is not taking bytes. Dropping some would corrupt the stream, so the console is closed instead.
      this.overflowed = true;
      this.queue = [];
      this.queuedBytes = 0;
      this.limits.onOverflow();
      return;
    }
    this.queue.push(bytes);
    this.queuedBytes += bytes.byteLength;
    this.flush();
  }

  /** The stream socket closed (or the console ended). */
  deliverClose(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.flush();
    this.state = "closed";
    this.onclose?.({ code, reason, wasClean: this.closeRequested || code === 1000 });
  }

  private flush(): void {
    if (this.handler === null || !this.opened) return;
    while (this.queue.length > 0 && this.handler !== null) {
      const next = this.queue.shift() as Uint8Array;
      this.queuedBytes -= next.byteLength;
      const copy = new Uint8Array(next.byteLength);
      copy.set(next);
      this.handler({ data: copy.buffer });
      this.limits.onConsumed(next.byteLength);
    }
  }
}
