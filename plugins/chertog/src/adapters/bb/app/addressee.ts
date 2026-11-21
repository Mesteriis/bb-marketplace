// Who a command for a chosen tile reaches. The tile names a thread; the
// composer is the one BB lists for exactly that thread. Nothing here looks at
// the DOM, the address bar or the last focused chat: no match or more than
// one match means the command is unavailable.
import { runForTarget, type AddresseeReader, type PanelTarget, type TargetedResult } from "../../../core/panels/index.ts";
import { Listeners } from "./content-sources.ts";
import { threadOfAddressee } from "./thread-source.ts";

/** The part of the SDK's composer handle the rule reads; `useComposers()` returns these. */
export interface ComposerHandle {
  readonly key: string;
  readonly scope: { readonly kind: string; readonly threadId?: string };
  focus(): void;
}

export type ComposerMatch<Composer> =
  | { readonly status: "one"; readonly composer: Composer }
  | { readonly status: "none" }
  /** The thread is on screen more than once, for example in a tile and in BB's own pane. */
  | { readonly status: "several"; readonly count: number };

/**
 * The composer of a thread's own chat. A queued-message editor carries the
 * same thread id and is not it; the new-thread composer has no thread.
 */
export function findThreadComposer<Composer extends ComposerHandle>(composers: readonly Composer[], threadId: string): ComposerMatch<Composer> {
  const found = composers.filter((composer) => composer.scope.kind === "thread" && composer.scope.threadId === threadId);
  if (found.length === 1) return { status: "one", composer: found[0] };
  return found.length === 0 ? { status: "none" } : { status: "several", count: found.length };
}

/** The composers BB lists for this window, as last reported by the component that reads the SDK hook. */
export class ComposerDirectory<Composer extends ComposerHandle = ComposerHandle> {
  private composers: readonly Composer[] = [];
  private readonly listeners = new Listeners();

  subscribe = this.listeners.subscribe;

  list = (): readonly Composer[] => this.composers;

  set(composers: readonly Composer[]): void {
    this.composers = composers;
    this.listeners.notify();
  }
}

export type TileCommandResult<R> =
  | TargetedResult<R>
  /** The tile's thread has no composer on screen, or several: nobody was addressed. */
  | { readonly status: "unavailable"; readonly reason: "no-composer" | "several-composers" | "not-a-thread" };

/**
 * Whether a command for the instance has someone to reach right now: the
 * instance is live, addresses a thread, and that thread has one composer.
 */
export function tileComposer<Composer extends ComposerHandle>(
  read: AddresseeReader,
  composers: readonly Composer[],
  instanceId: string,
): ComposerMatch<Composer> | { readonly status: "not-a-thread" } {
  const addressee = read(instanceId);
  const threadId = addressee === null ? null : threadOfAddressee(addressee);
  return threadId === null ? { status: "not-a-thread" } : findThreadComposer(composers, threadId);
}

/**
 * Runs a command for the composer of the tile's thread. The tile's instance
 * and addressee, and the composer found for them, are fixed before `work`
 * starts. After it, `act` runs only if the instance still addresses the same
 * thread and that thread still has that one composer; otherwise nothing is
 * done.
 */
export async function runForTileComposer<Composer extends ComposerHandle, T, R>(
  read: AddresseeReader,
  composers: () => readonly Composer[],
  instanceId: string,
  work: (target: PanelTarget) => Promise<T>,
  act: (composer: Composer, value: T) => R | Promise<R>,
): Promise<TileCommandResult<R>> {
  const before = tileComposer(read, composers(), instanceId);
  if (before.status === "not-a-thread") {
    return read(instanceId) === null ? { status: "cancelled", reason: "target-unavailable" } : { status: "unavailable", reason: "not-a-thread" };
  }
  if (before.status !== "one") return { status: "unavailable", reason: before.status === "none" ? "no-composer" : "several-composers" };
  const captured = before.composer.key;

  const result = await runForTarget<T, TileCommandResult<R>>(read, instanceId, work, async (value) => {
    const now = tileComposer(read, composers(), instanceId);
    if (now.status === "not-a-thread") return { status: "cancelled", reason: "target-gone" };
    if (now.status !== "one") return { status: "unavailable", reason: now.status === "none" ? "no-composer" : "several-composers" };
    // Another composer for the same thread is not the one the command was given for.
    if (now.composer.key !== captured) return { status: "cancelled", reason: "target-changed" };
    return { status: "done", value: await act(now.composer, value) };
  });
  return result.status === "done" ? result.value : result;
}
