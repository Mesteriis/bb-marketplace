// A child process double for gitwand-bridge: records request lines, answers
// with whatever a test writes, and exits when told to.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";

export interface FakeRequest {
  id: number;
  cmd: string;
  args: Record<string, unknown>;
  conn?: string;
}

export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: FakeRequest[] = [];
  readonly signals: string[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdinClosed = false;
  /** Called for each request line; the default answers __hello. */
  onRequest: (req: FakeRequest) => void = (req) => {
    if (req.cmd === "__hello") this.reply({ id: req.id, ok: { protocol: 1, version: "3.14.0", runtime: "3.14.0+bb1", commit: "c".repeat(40), generated: 336, adapted: [] } });
  };

  constructor() {
    super();
    createInterface({ input: this.stdin }).on("line", (line) => {
      const req = JSON.parse(line) as FakeRequest;
      this.requests.push(req);
      this.onRequest(req);
    });
    this.stdin.on("finish", () => {
      this.stdinClosed = true;
      this.emit("stdin-closed");
    });
  }

  reply(message: unknown): void {
    this.stdout.write(JSON.stringify(message) + "\n");
  }

  writeRaw(line: string): void {
    this.stdout.write(line + "\n");
  }

  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  kill(signal = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }
}
