// In-memory ports for core tests.
import type {
  AppCredentials,
  AppCredentialsSource,
  Clock,
  HttpFetch,
  HttpRequest,
  PendingLogin,
  PendingLoginStore,
  Random,
  StoredTokens,
  TokenStore,
} from "../ports.ts";

export class FakeClock implements Clock {
  constructor(public time: number) {}
  now(): number {
    return this.time;
  }
}

export class MemoryTokenStore implements TokenStore {
  saves: StoredTokens[] = [];
  constructor(public tokens: StoredTokens | null = null) {}
  async load() {
    return this.tokens;
  }
  async save(tokens: StoredTokens) {
    this.tokens = tokens;
    this.saves.push(tokens);
  }
  async clear() {
    this.tokens = null;
  }
}

export class MemoryPendingLogins implements PendingLoginStore {
  readonly logins = new Map<string, PendingLogin>();
  async put(login: PendingLogin) {
    this.logins.set(login.state, login);
  }
  async take(state: string) {
    const login = this.logins.get(state) ?? null;
    this.logins.delete(state);
    return login;
  }
}

export function credentials(value: AppCredentials | null): AppCredentialsSource {
  return { get: async () => value };
}

/** Hands out the given tokens in order. */
export function fixedRandom(...tokens: string[]): Random {
  const queue = [...tokens];
  return {
    token() {
      const next = queue.shift();
      if (next === undefined) throw new Error("fixedRandom ran out of tokens");
      return next;
    },
  };
}

export interface RecordedCall {
  readonly url: string;
  readonly request: HttpRequest;
}

export type Reply = { status: number; body: unknown } | Error | Promise<{ status: number; body: unknown }>;

/** A fetch that answers from a queue and records what it was asked. */
export function scriptedFetch(...replies: Reply[]): { fetch: HttpFetch; calls: RecordedCall[] } {
  const queue = [...replies];
  const calls: RecordedCall[] = [];
  const fetch: HttpFetch = async (url, request) => {
    calls.push({ url, request });
    const reply = queue.shift();
    if (reply === undefined) throw new Error(`scriptedFetch has no reply for ${request.method} ${url}`);
    if (reply instanceof Error) throw reply;
    const { status, body } = await reply;
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { fetch, calls };
}
