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
  private openHandler: (() => void) | null = null;
  private openAnnounced = false;
  private handler: ((event: VncChannelMessage) => void) | null = null;
  private state: VncChannelState = "connecting";
  /** Bytes that arrived before noVNC set `onmessage`; handed over in order as soon as it does. */
  private queue: Uint8Array[] = [];
  private opened = false;
  private closeRequested = false;

  constructor(
    private readonly out: (bytes: Uint8Array) => void,
    /** noVNC called `close()`: the page tears the socket down. */
    private readonly onCloseRequested: () => void,
  ) {}

  get onopen(): (() => void) | null {
    return this.openHandler;
  }

  /** noVNC assigns this when it attaches, which may be after the socket opened: it is told then, once. */
  set onopen(handler: (() => void) | null) {
    this.openHandler = handler;
    this.announceOpen();
  }

  get onmessage(): ((event: VncChannelMessage) => void) | null {
    return this.handler;
  }

  /** noVNC assigns this after the object was handed over: whatever waited is delivered at that moment, in order. */
  set onmessage(handler: ((event: VncChannelMessage) => void) | null) {
    this.handler = handler;
    this.flush();
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
    this.announceOpen();
    this.flush();
  }

  /** Raw RFB bytes from the console. */
  deliver(bytes: Uint8Array): void {
    if (this.state === "closed") return;
    this.queue.push(bytes);
    this.flush();
  }

  /** The stream socket closed (or the console ended). */
  deliverClose(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.flush();
    this.state = "closed";
    this.onclose?.({ code, reason, wasClean: this.closeRequested || code === 1000 });
  }

  private announceOpen(): void {
    if (!this.opened || this.openAnnounced || this.openHandler === null) return;
    this.openAnnounced = true;
    this.openHandler();
  }

  private flush(): void {
    if (this.handler === null || !this.opened) return;
    while (this.queue.length > 0 && this.handler !== null) {
      const next = this.queue.shift() as Uint8Array;
      const copy = new Uint8Array(next.byteLength);
      copy.set(next);
      this.handler({ data: copy.buffer });
    }
  }
}
