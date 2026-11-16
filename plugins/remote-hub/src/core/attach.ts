// Host-free single-use attach token with a TTL, and the session credit state.


export interface Clock {
  now(): number;
}

export const realClock: Clock = { now: () => Date.now() };

export interface AttachToken {
  token: string;
  sessionId: number;
  generation: string;
  expiresAt: number;
}

/** A 128-bit (32 hex char) token (host-free: Web Crypto). */
export function newAttachToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Single-use attach-token registry: a token is consumed on first use and
 * expires after ttlMs.
 */
export class AttachTokens {
  private readonly tokens = new Map<string, AttachToken>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  issue(sessionId: number, generation: string): string {
    const token = newAttachToken();
    this.tokens.set(token, {
      token,
      sessionId,
      generation,
      expiresAt: this.clock.now() + this.ttlMs,
    });
    return token;
  }

  /** Consume the token on first use; unknown/expired returns null. */
  consume(token: string): { sessionId: number; generation: string } | null {
    const entry = this.tokens.get(token);
    if (entry === undefined) return null;
    this.tokens.delete(token);
    if (this.clock.now() > entry.expiresAt) return null;
    return { sessionId: entry.sessionId, generation: entry.generation };
  }
}

export const ATTACH_TOKEN_TTL_MS = 30_000;
