// Test doubles of the window side: an RPC that keeps one document the way the
// plugin's server does, with switches to hold a save, fail it, or let another
// window save first.
import type { WorkspaceDocument, WorkspaceReadResult, WorkspaceSaveResult } from "../../../src/core/workspace/index.ts";
import { decideSave } from "../../../src/core/workspace/index.ts";
import type { WorkspaceRpcPort } from "../../../src/adapters/bb/app/workspace-controller.ts";

interface Gate {
  promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** One recorded save: what the window sent and against which revision. */
export interface SaveCall {
  readonly document: WorkspaceDocument;
  readonly expectedRevision: number;
}

export class FakeWorkspaceRpc implements WorkspaceRpcPort {
  /** What the server holds; a test sets it to act as another window. */
  stored: WorkspaceDocument | null = null;
  /** The answer to `load` when it is not the stored document. */
  loadAnswer: WorkspaceReadResult | null = null;
  loadFailure: Error | null = null;
  loads = 0;
  readonly saves: SaveCall[] = [];
  /** Failures of the next saves, first in, first out. */
  readonly saveFailures: Error[] = [];
  /** Answers of the next saves that replace the store's own rule. */
  readonly saveAnswers: WorkspaceSaveResult[] = [];
  private held: Gate | null = null;

  /** Saves wait from now on, until `release`. */
  hold(): void {
    this.held = gate();
  }

  release(): void {
    this.held?.open();
    this.held = null;
  }

  async load(): Promise<WorkspaceReadResult> {
    this.loads += 1;
    if (this.loadFailure !== null) throw this.loadFailure;
    if (this.loadAnswer !== null) return this.loadAnswer;
    if (this.stored === null) return { status: "empty" };
    return { status: "ok", document: this.stored, migratedFrom: null, dropped: [] };
  }

  async save(document: WorkspaceDocument, expectedRevision: number): Promise<WorkspaceSaveResult> {
    this.saves.push({ document, expectedRevision });
    if (this.held !== null) await this.held.promise;
    const failure = this.saveFailures.shift();
    if (failure !== undefined) throw failure;
    const answer = this.saveAnswers.shift();
    if (answer !== undefined) return answer;
    const result = decideSave(this.stored, document, expectedRevision);
    if (result.status === "saved") this.stored = result.document;
    return result;
  }
}

/** Yields `<prefix>-1`, `<prefix>-2`, … per prefix. */
export function sequentialIds(): (prefix: string) => string {
  const counts = new Map<string, number>();
  return (prefix) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return prefix + "-" + next;
  };
}

/** Lets every pending promise callback run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}
