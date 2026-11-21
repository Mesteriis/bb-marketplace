// Test doubles for the panel registry: a provider that counts every call the
// registry makes, a fixed clock and a sequential id generator.
import { z } from "zod";
import type {
  Clock,
  IdGenerator,
  PanelCapabilities,
  PanelEndSessionOutcome,
  PanelOpenOutcome,
  PanelOpenRequest,
  PanelParam,
  PanelProvider,
  PanelRef,
} from "../../../src/core/panels/index.ts";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const NO_CAPABILITIES: PanelCapabilities = {
  showNativeRoute: "no",
  embedInstance: "no",
  keepLiveInDocument: "no",
  rebindToSession: "no",
  transferBetweenWindows: "no",
  restoreAfterRestart: "no",
};

export class FakeProvider implements PanelProvider {
  readonly capabilities = NO_CAPABILITIES;
  multipleViews = false;
  endsSession = false;

  /** instanceId of every call, in call order. */
  readonly opens: string[] = [];
  readonly releases: string[] = [];
  readonly endSessions: string[] = [];

  openResult: () => Promise<PanelOpenOutcome> = async () => ({ status: "live", addressee: null });
  releaseResult: () => void | Promise<void> = () => undefined;
  endSessionResult: () => Promise<PanelEndSessionOutcome> = async () => "ended";

  /**
   * `paramNames` are the only parameters this provider's references may
   * carry; each is an optional string.
   */
  readonly paramsSchema: z.ZodType<Readonly<Record<string, PanelParam | undefined>>>;

  constructor(
    readonly type: string,
    paramNames: readonly string[] = ["threadId", "meeting"],
  ) {
    this.paramsSchema = z.strictObject(Object.fromEntries(paramNames.map((name) => [name, z.string().optional()])));
  }

  open(request: PanelOpenRequest): Promise<PanelOpenOutcome> {
    this.opens.push(request.instanceId);
    return this.openResult();
  }

  release(instanceId: string): void | Promise<void> {
    this.releases.push(instanceId);
    return this.releaseResult();
  }

  endsSessionOnLastClose(_ref: PanelRef): boolean {
    return this.endsSession;
  }

  endSession(instanceId: string): Promise<PanelEndSessionOutcome> {
    this.endSessions.push(instanceId);
    return this.endSessionResult();
  }
}

export class FakeClock implements Clock {
  constructor(public time: number) {}
  now(): number {
    return this.time;
  }
}

/** Yields `panel-1`, `panel-2`, … */
export class SequentialIds implements IdGenerator {
  private count = 0;
  nextId(): string {
    this.count += 1;
    return "panel-" + this.count;
  }
}
