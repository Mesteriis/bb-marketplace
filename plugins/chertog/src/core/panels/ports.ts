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
