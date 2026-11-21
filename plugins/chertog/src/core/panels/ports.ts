// Ports the panel registry needs from its host. The core declares them; an
// adapter supplies the implementation.

/** Wall-clock time. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** Source of identifiers for live panel instances. */
export interface IdGenerator {
  /** A new identifier, never returned before by this generator. */
  nextId(): string;
}

/** Where the registry reports failures of code it calls but does not own. */
export interface Diagnostics {
  /**
   * Records a failure. `where` names the call that failed, for example
   * `panel-registry-subscriber` or `panel-provider-release`. The registry
   * carries on whatever this method does, even if it throws.
   */
  failure(where: string, error: unknown): void;
}
