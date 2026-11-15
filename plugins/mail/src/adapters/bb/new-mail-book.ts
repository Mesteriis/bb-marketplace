// New-mail toasts (slice 3e): the message ids of one round's toast, kept in
// memory under a random token. The realtime signal carries the token only;
// the page asks new_mail_get(token) for the senders. Ids only, never content;
// at most NEW_MAIL_BOOK_SIZE entries, each gone after NEW_MAIL_TTL_MS or a
// restart.
import type { Clock } from "../../core/index.ts";

export const NEW_MAIL_BOOK_SIZE = 20;
export const NEW_MAIL_TTL_MS = 10 * 60_000;

export class NewMailBook {
  private readonly entries = new Map<string, { ids: string[]; at: number }>();

  constructor(
    private readonly clock: Clock,
    /** A fresh unguessable token per call. */
    private readonly random: () => string,
  ) {}

  private prune(now: number): void {
    for (const [token, entry] of this.entries) {
      if (now - entry.at >= NEW_MAIL_TTL_MS) this.entries.delete(token);
    }
  }

  /** Stores the ids under a new token; the oldest entry goes beyond the size. */
  put(ids: string[]): string {
    const now = this.clock.now().getTime();
    this.prune(now);
    let token = this.random();
    while (this.entries.has(token)) token = this.random();
    this.entries.set(token, { ids: [...ids], at: now });
    while (this.entries.size > NEW_MAIL_BOOK_SIZE) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return token;
  }

  /** The ids of a live token; null for an unknown or expired one. */
  get(token: string): string[] | null {
    this.prune(this.clock.now().getTime());
    const entry = this.entries.get(token);
    return entry === undefined ? null : [...entry.ids];
  }
}
