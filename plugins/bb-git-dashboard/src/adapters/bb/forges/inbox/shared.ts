import type { Account } from "../../../../core/providers.ts";
import { originOf, text } from "../../provider-http.ts";

/** A forge link kept only over https on the account's own server. */
export function ownLink(account: Account, value: unknown): string | null {
  try {
    const url = new URL(text(value));
    const origin = originOf(account) === "https://api.github.com" ? "https://github.com" : originOf(account);
    return url.origin === origin && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** A header count, or undefined when the forge left it out. */
export function headerCount(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** Runs `work` over `items`, at most `limit` at a time, keeping order. */
export async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]); }
  }));
  return results;
}
