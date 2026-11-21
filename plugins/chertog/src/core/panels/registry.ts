// The registry of live panel instances. A layout places instances; this
// module owns their lifetime. Three actions stay separate on purpose:
// removing from the layout hides an instance and keeps it live, closing
// releases its view exactly once, and ending the session happens only on an
// explicit call and is carried out by the provider.
import type { Clock, Diagnostics, IdGenerator } from "./ports.ts";
import type { PanelProvider, PanelState } from "./provider.ts";
import { panelRefKey, panelRefSchema, type PanelRef } from "./ref.ts";

/**
 * A live panel instance: one open view of one reference. `instanceId` does
 * not depend on the tile, the tab index, the layout name or the tree path.
 * Snapshots are immutable; read the registry again for the current state.
 */
export interface PanelInstance {
  readonly instanceId: string;
  /**
   * The reference the instance was opened from. Its parameters are given out
   * only after the provider's own schema accepted them; until then `params`
   * is empty, because nothing has confirmed they are plain identifiers.
   */
  readonly ref: PanelRef;
  /** Whether the provider has checked the parameters, so that `ref` carries them. */
  readonly paramsVerified: boolean;
  readonly state: PanelState;
  /** False while the instance is removed from the layout but still held. */
  readonly placed: boolean;
  /** Who receives input from this panel; null unless the panel is live and has an addressee. */
  readonly addressee: string | null;
  /**
   * The operation whose result the provider could not tell. The registry
   * never repeats that operation on its own.
   */
  readonly unknownOutcome: "open" | "end-session" | null;
  /** When the instance was created, in the clock's milliseconds. */
  readonly openedAt: number;
  /** When the instance was last removed from the layout, or null while placed. */
  readonly hiddenAt: number | null;
}

export interface PanelOpenOptions {
  /** Ask for one more view of a reference that is already open. */
  readonly newView?: boolean;
}

export type PanelOpenResult =
  | {
      readonly ok: true;
      /** The instance as it is right after the call. */
      readonly instance: PanelInstance;
      /** The instance once the provider has answered, or null if it was closed before that. */
      readonly settled: Promise<PanelInstance | null>;
    }
  | { readonly ok: false; readonly reason: "invalid-ref" | "multiple-views-unsupported" };

export type PanelRetryResult =
  | { readonly ok: true; readonly instance: PanelInstance; readonly settled: Promise<PanelInstance | null> }
  | { readonly ok: false; readonly reason: "not-open" | "busy" | "already-live" | "provider-missing" | "invalid-ref" };

export interface PanelCloseOptions {
  /** The user has seen the warning and still wants to close. */
  readonly confirmEndsSession?: boolean;
}

export type PanelCloseResult =
  | {
      readonly status: "closed";
      /** `not-needed`: no provider held a view. `failed`: the provider's release threw; it is not repeated. */
      readonly release: "done" | "failed" | "not-needed";
    }
  /** Nothing was closed: closing this last view ends the session. Offer to hide the panel instead. */
  | { readonly status: "needs-confirmation"; readonly warning: "ends-session" }
  | { readonly status: "not-open" };

export interface PanelEndSessionResult {
  readonly status: "ended" | "unknown" | "busy" | "not-live" | "not-open";
}

interface Entry {
  readonly instanceId: string;
  /** The full reference. Handed to the provider, and to callers only once verified. */
  readonly ref: PanelRef;
  /** The reference without its parameters, given out while they are unverified. */
  readonly withheldRef: PanelRef;
  readonly key: string;
  readonly openedAt: number;
  /** Whether the provider's schema has accepted the parameters. */
  verified: boolean;
  state: PanelState;
  placed: boolean;
  addressee: string | null;
  unknownOutcome: "open" | "end-session" | null;
  hiddenAt: number | null;
  /** The provider that was asked to open a view and has not released it. */
  view: PanelProvider | null;
  /** Number of the current open attempt; an answer to an older one is ignored. */
  attempt: number;
  /**
   * The participation in the provider's session this view belongs to. Views
   * of one reference share it while the session lasts; a view opened after
   * the session is over, or after every earlier view is gone, starts a new one.
   */
  generation: number;
  endingSession: boolean;
  settled: Promise<PanelInstance | null>;
}

function holdsSession(entry: Entry): boolean {
  return entry.state === "live" || entry.state === "loading";
}

export class PanelRegistry {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly diagnostics: Diagnostics;
  private readonly providers = new Map<string, PanelProvider>();
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private lastGeneration = 0;

  constructor(ports: { clock: Clock; ids: IdGenerator; diagnostics: Diagnostics }) {
    this.clock = ports.clock;
    this.ids = ports.ids;
    this.diagnostics = ports.diagnostics;
  }

  /**
   * Makes a provider available. Returns the function that removes it again.
   * Registering does not open anything: a kept reference is opened by the
   * next `open` of it, and a panel that was live before needs `retryOpen`.
   */
  registerProvider(provider: PanelProvider): () => void {
    if (this.providers.has(provider.type)) {
      throw new Error('Panel provider "' + provider.type + '" is already registered');
    }
    this.providers.set(provider.type, provider);
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.verified || entry.ref.provider !== provider.type) continue;
      if (!provider.paramsSchema.safeParse(entry.ref.params).success) continue;
      entry.verified = true;
      changed = true;
    }
    if (changed) this.notify();
    return () => this.unregisterProvider(provider);
  }

  /**
   * Opens a reference for placing in the layout. The same reference yields
   * the same instance and no second provider call, unless `newView` is set
   * and the provider declares several views. A hidden instance is reused and
   * counts as placed again. A reference with parameters its provider does
   * not declare is refused. While the provider is missing the reference is
   * kept so that it can be opened later, but its parameters are held opaque:
   * they are not given out until the provider appears and accepts them.
   */
  open(ref: PanelRef, options: PanelOpenOptions = {}): PanelOpenResult {
    const parsed = panelRefSchema.safeParse(ref);
    if (!parsed.success) return { ok: false, reason: "invalid-ref" };
    const key = panelRefKey(parsed.data);
    const provider = this.providers.get(parsed.data.provider);
    if (provider !== undefined && !provider.paramsSchema.safeParse(parsed.data.params).success) {
      return { ok: false, reason: "invalid-ref" };
    }

    if (options.newView === true) {
      if (provider === undefined || !provider.multipleViews) return { ok: false, reason: "multiple-views-unsupported" };
    } else {
      const existing = this.findByKey(key);
      if (existing !== undefined) return this.reuse(existing, provider);
    }

    const instanceId = this.ids.nextId();
    if (this.entries.has(instanceId)) {
      throw new Error('Panel instance id "' + instanceId + '" was issued twice');
    }
    const entry: Entry = {
      instanceId,
      ref: Object.freeze({ provider: parsed.data.provider, params: Object.freeze({ ...parsed.data.params }) }),
      withheldRef: Object.freeze({ provider: parsed.data.provider, params: Object.freeze({}) }),
      key,
      openedAt: this.clock.now(),
      verified: provider !== undefined,
      state: "provider-missing",
      placed: true,
      addressee: null,
      unknownOutcome: null,
      hiddenAt: null,
      view: null,
      attempt: 0,
      generation: 0,
      endingSession: false,
      settled: Promise.resolve(null),
    };
    this.entries.set(instanceId, entry);
    if (provider === undefined) {
      entry.settled = Promise.resolve(this.snapshot(entry));
    } else {
      this.attemptOpen(entry, provider);
    }
    this.notify();
    return { ok: true, instance: this.snapshot(entry), settled: entry.settled };
  }

  /**
   * Asks the provider again for an instance that is not live. This is the
   * only way a second open reaches the provider after an ended session, a
   * refusal, a loss or an unknown outcome, so it must follow a user action.
   */
  retryOpen(instanceId: string): PanelRetryResult {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return { ok: false, reason: "not-open" };
    if (entry.state === "loading") return { ok: false, reason: "busy" };
    if (entry.state === "live") return { ok: false, reason: "already-live" };
    const provider = this.providers.get(entry.ref.provider);
    if (provider === undefined) return { ok: false, reason: "provider-missing" };
    if (!provider.paramsSchema.safeParse(entry.ref.params).success) return { ok: false, reason: "invalid-ref" };
    entry.verified = true;
    this.attemptOpen(entry, provider);
    this.notify();
    return { ok: true, instance: this.snapshot(entry), settled: entry.settled };
  }

  get(instanceId: string): PanelInstance | null {
    const entry = this.entries.get(instanceId);
    return entry === undefined ? null : this.snapshot(entry);
  }

  /** Every instance the registry holds, placed or hidden, in the order they were opened. */
  list(): PanelInstance[] {
    return [...this.entries.values()].map((entry) => this.snapshot(entry));
  }

  /** Instances that are out of the layout and still hold a provider's view. */
  hiddenLive(): PanelInstance[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.placed && holdsSession(entry))
      .map((entry) => this.snapshot(entry));
  }

  /** Changes placement only: the instance stays as live as it was. False if it is not open. */
  removeFromLayout(instanceId: string): boolean {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return false;
    if (entry.placed) {
      entry.placed = false;
      entry.hiddenAt = this.clock.now();
      this.notify();
    }
    return true;
  }

  /** Marks a hidden instance as placed again. False if it is not open. */
  returnToLayout(instanceId: string): boolean {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return false;
    if (!entry.placed) {
      entry.placed = true;
      entry.hiddenAt = null;
      this.notify();
    }
    return true;
  }

  /**
   * Closes the panel: forgets the instance and releases its view once.
   * Repeating the call is safe and releases nothing. When closing the last
   * view would end the session, nothing happens until the caller confirms.
   */
  async close(instanceId: string, options: PanelCloseOptions = {}): Promise<PanelCloseResult> {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return { status: "not-open" };
    if (options.confirmEndsSession !== true && this.closingEndsSession(entry)) {
      return { status: "needs-confirmation", warning: "ends-session" };
    }
    this.entries.delete(instanceId);
    const provider = entry.view;
    entry.view = null;
    entry.attempt += 1;
    if (provider === null) {
      this.notify();
      return { status: "closed", release: "not-needed" };
    }
    // The release starts before anyone is told about the close, so nothing a
    // subscriber does can leave the view behind.
    let releasing: void | Promise<void> = undefined;
    let failed = false;
    try {
      releasing = provider.release(instanceId);
    } catch (error) {
      failed = true;
      this.reportFailure("panel-provider-release", error);
    }
    this.notify();
    try {
      await releasing;
    } catch (error) {
      failed = true;
      this.reportFailure("panel-provider-release", error);
    }
    return { status: "closed", release: failed ? "failed" : "done" };
  }

  /**
   * Leaves the call or disconnects the session through the provider. Nothing
   * else in the registry does this. An unknown result leaves the panel live
   * and flagged; the call is not repeated.
   */
  async endSession(instanceId: string): Promise<PanelEndSessionResult> {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return { status: "not-open" };
    if (entry.state !== "live" || entry.view === null) return { status: "not-live" };
    if (entry.endingSession) return { status: "busy" };
    entry.endingSession = true;
    const provider = entry.view;
    // The answer is about the participation that exists now: the views that
    // hold it at this moment, loading ones included. A view opened later is
    // not part of what the provider was asked to end.
    const generation = entry.generation;
    const asked = new Set<string>();
    for (const other of this.entries.values()) {
      if (other.generation === generation && holdsSession(other)) asked.add(other.instanceId);
    }
    let outcome: "ended" | "unknown";
    try {
      outcome = (await provider.endSession(instanceId)) === "ended" ? "ended" : "unknown";
    } catch (error) {
      outcome = "unknown";
      this.reportFailure("panel-provider-end-session", error);
    }
    entry.endingSession = false;
    const stillOpen = this.entries.get(instanceId) === entry;
    if (outcome === "ended") {
      // The session is over for its other views even if this one was closed
      // while the provider was answering.
      if (stillOpen) entry.unknownOutcome = null;
      this.markSessionEnded(generation, asked);
      this.notify();
    } else if (stillOpen) {
      entry.unknownOutcome = "end-session";
      this.notify();
    }
    return { status: outcome };
  }

  /**
   * The provider tells that a live panel stopped being live. False if the
   * panel is not live. `session-ended` is about the session, so it ends
   * every view of it; `access-denied` and `lost` are about this view only.
   */
  report(instanceId: string, state: "session-ended" | "access-denied" | "lost"): boolean {
    const entry = this.entries.get(instanceId);
    if (entry === undefined || entry.state !== "live") return false;
    if (state === "session-ended") {
      this.markSessionEnded(entry.generation);
    } else {
      entry.state = state;
      entry.addressee = null;
    }
    this.notify();
    return true;
  }

  /** The provider tells who a live panel now addresses. False if the panel is not live. */
  setAddressee(instanceId: string, addressee: string | null): boolean {
    const entry = this.entries.get(instanceId);
    if (entry === undefined || entry.state !== "live") return false;
    if (entry.addressee !== addressee) {
      entry.addressee = addressee;
      this.notify();
    }
    return true;
  }

  /** Who a live panel addresses; null for a panel that is not open, not live or takes no input. */
  addresseeOf(instanceId: string): string | null {
    const entry = this.entries.get(instanceId);
    return entry !== undefined && entry.state === "live" ? entry.addressee : null;
  }

  /**
   * Calls the listener after every change. Returns the function that stops
   * it. A listener that throws is reported to diagnostics and does not
   * affect the registry or the other listeners.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private reuse(entry: Entry, provider: PanelProvider | undefined): PanelOpenResult {
    let changed = false;
    // The caller checked the reference against the provider's schema.
    if (provider !== undefined && !entry.verified) {
      entry.verified = true;
      changed = true;
    }
    if (!entry.placed) {
      entry.placed = true;
      entry.hiddenAt = null;
      changed = true;
    }
    // A reference whose provider was missing has never been asked for, so
    // this is its first open, not a repeat.
    if (entry.state === "provider-missing" && provider !== undefined) {
      this.attemptOpen(entry, provider);
      changed = true;
    }
    if (changed) this.notify();
    // Only a pending open has an answer to wait for; an earlier answer may
    // describe a state the instance has since left.
    const settled = entry.state === "loading" ? entry.settled : Promise.resolve(this.snapshot(entry));
    return { ok: true, instance: this.snapshot(entry), settled };
  }

  private attemptOpen(entry: Entry, provider: PanelProvider): void {
    entry.generation = this.generationToJoin(entry, provider);
    entry.state = "loading";
    entry.addressee = null;
    entry.unknownOutcome = null;
    entry.view = provider;
    entry.attempt += 1;
    entry.settled = this.settleOpen(entry, provider, entry.attempt);
  }

  private async settleOpen(entry: Entry, provider: PanelProvider, attempt: number): Promise<PanelInstance | null> {
    let outcome: Awaited<ReturnType<PanelProvider["open"]>>;
    try {
      outcome = await provider.open({ instanceId: entry.instanceId, ref: entry.ref });
    } catch (error) {
      outcome = { status: "unknown" };
      this.reportFailure("panel-provider-open", error);
    }
    if (this.entries.get(entry.instanceId) !== entry) return null;
    if (entry.attempt !== attempt) return this.snapshot(entry);
    if (outcome.status === "live") {
      entry.state = "live";
      entry.addressee = outcome.addressee;
    } else if (outcome.status === "session-ended") {
      this.markSessionEnded(entry.generation);
    } else if (outcome.status === "access-denied") {
      entry.state = "access-denied";
    } else {
      entry.state = "lost";
      entry.unknownOutcome = outcome.status === "lost" ? null : "open";
    }
    this.notify();
    return this.snapshot(entry);
  }

  private unregisterProvider(provider: PanelProvider): void {
    if (this.providers.get(provider.type) !== provider) return;
    this.providers.delete(provider.type);
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.view !== provider) continue;
      // The provider's views are gone with it: nothing is left to release,
      // and an answer still on its way no longer counts.
      entry.view = null;
      entry.attempt += 1;
      if (holdsSession(entry)) {
        entry.state = "lost";
        entry.addressee = null;
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /**
   * The session is over for every view of that participation, not only for
   * the one the user acted in: none of them stays live or keeps an addressee.
   * A view still loading is ended too, and its late answer is ignored. With
   * `only`, the end applies to those instances alone.
   */
  private markSessionEnded(generation: number, only?: ReadonlySet<string>): void {
    for (const entry of this.entries.values()) {
      if (entry.generation !== generation || !holdsSession(entry)) continue;
      if (only !== undefined && !only.has(entry.instanceId)) continue;
      entry.state = "session-ended";
      entry.addressee = null;
      entry.attempt += 1;
    }
  }

  /**
   * The participation a view about to be opened belongs to: the one another
   * view of the same reference and provider still holds, or a new one.
   */
  private generationToJoin(opening: Entry, provider: PanelProvider): number {
    for (const entry of this.entries.values()) {
      if (entry !== opening && entry.key === opening.key && entry.view === provider && holdsSession(entry)) {
        return entry.generation;
      }
    }
    this.lastGeneration += 1;
    return this.lastGeneration;
  }

  /**
   * Whether releasing this view may end the session. The view counts when it
   * is live, loading or was opened with an unknown outcome: in each case a
   * session may stand behind it. Another view keeps the session only when
   * the provider confirmed it live; a loading or unknown one may never be.
   */
  private closingEndsSession(entry: Entry): boolean {
    if (entry.view === null) return false;
    if (!holdsSession(entry) && entry.unknownOutcome !== "open") return false;
    if (!entry.view.endsSessionOnLastClose(entry.ref)) return false;
    for (const other of this.entries.values()) {
      if (other !== entry && other.key === entry.key && other.state === "live") return false;
    }
    return true;
  }

  private findByKey(key: string): Entry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.key === key) return entry;
    }
    return undefined;
  }

  private snapshot(entry: Entry): PanelInstance {
    return Object.freeze({
      instanceId: entry.instanceId,
      ref: entry.verified ? entry.ref : entry.withheldRef,
      paramsVerified: entry.verified,
      state: entry.state,
      placed: entry.placed,
      addressee: entry.addressee,
      unknownOutcome: entry.unknownOutcome,
      openedAt: entry.openedAt,
      hiddenAt: entry.hiddenAt,
    });
  }

  /**
   * Tells every subscriber about a change. A subscriber that throws is
   * reported and skipped: it stops neither the other subscribers nor the
   * registry operation that caused the change.
   */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.reportFailure("panel-registry-subscriber", error);
      }
    }
  }

  /** Hands a failure to diagnostics; a failing diagnostics port must not break the registry either. */
  private reportFailure(where: string, error: unknown): void {
    try {
      this.diagnostics.failure(where, error);
    } catch {
      // Nothing is left to report to.
    }
  }
}
