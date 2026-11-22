// Host-free single-use attach token with a TTL, per-session and global caps,
// and a sweep that expires abandoned tokens on issue/consume.

export interface Clock {
  now(): number;
}

export const realClock: Clock = { now: () => Date.now() };

export interface AttachBinding {
  sessionId: number;
  generation: string;
  embeddedVnc?: true;
}

export interface AttachToken extends AttachBinding {
  token: string;
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

export const ATTACH_TOKEN_TTL_MS = 30_000;
export const MAX_TOKENS_PER_SESSION = 8;
export const MAX_TOKENS_TOTAL = 256;

/**
 * Single-use attach-token registry: a token is consumed on first use, expires
 * after ttlMs, and the registry is swept on issue/consume so abandoned tokens
 * cannot grow without bound.
 */
export class AttachTokens {
  private readonly tokens = new Map<string, AttachToken>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  get size(): number {
    return this.tokens.size;
  }

  /** Remove every expired entry; also evict oldest entries beyond the caps. */
  private sweep(): void {
    const now = this.clock.now();
    for (const [token, entry] of this.tokens) {
      if (now > entry.expiresAt) this.tokens.delete(token);
    }
    const perSession = new Map<string, AttachToken[]>();
    for (const entry of this.tokens.values()) {
      const key = entry.generation + ":" + entry.sessionId;
      const list = perSession.get(key) ?? [];
      list.push(entry);
      perSession.set(key, list);
    }
    for (const list of perSession.values()) {
      list.sort((a, b) => a.expiresAt - b.expiresAt);
      while (list.length > MAX_TOKENS_PER_SESSION) {
        const oldest = list.shift();
        if (oldest !== undefined) this.tokens.delete(oldest.token);
      }
    }
    if (this.tokens.size > MAX_TOKENS_TOTAL) {
      const all = Array.from(this.tokens.values()).sort((a, b) => a.expiresAt - b.expiresAt);
      while (this.tokens.size > MAX_TOKENS_TOTAL && all.length > 0) {
        const oldest = all.shift();
        if (oldest !== undefined) this.tokens.delete(oldest.token);
      }
    }
  }

  issue(sessionId: number, generation: string, embeddedVnc = false): string {
    const token = newAttachToken();
    this.tokens.set(token, {
      token,
      sessionId,
      generation,
      ...(embeddedVnc && { embeddedVnc: true as const }),
      expiresAt: this.clock.now() + this.ttlMs,
    });
    this.sweep();
    return token;
  }

  /** Consume the token on first use; unknown/expired returns null. */
  consume(token: string): AttachBinding | null {
    this.sweep();
    const entry = this.tokens.get(token);
    if (entry === undefined) return null;
    this.tokens.delete(token);
    if (this.clock.now() > entry.expiresAt) return null;
    return { sessionId: entry.sessionId, generation: entry.generation, ...(entry.embeddedVnc && { embeddedVnc: true }) };
  }

  /** Revoke every outstanding token of one helper generation. */
  revokeGeneration(generation: string): void {
    for (const [token, entry] of this.tokens) {
      if (entry.generation === generation) this.tokens.delete(token);
    }
  }
}
