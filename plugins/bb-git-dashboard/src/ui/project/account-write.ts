import type { Preview, RemoteAction, RemoteOutcome } from "../../core/publication.ts";

/** The account repository a copy is linked to, and the previewed writes through that account. */
export type AccountSync = {
  /** The copy's linked account repository; null when the copy is not linked. */
  target(): Promise<{accountId: string; repoId: string} | null>;
  prepare(target: {accountId: string; repoId: string}, action: RemoteAction): Promise<Preview>;
  publish(previewId: string): Promise<RemoteOutcome>;
};

/**
 * Asks the server for the write's preview through the copy's linked account; the caller shows it with AccountConfirm.
 * A copy not linked gets NO_ACCOUNT_LINK and nothing is asked of the server.
 */
export async function prepareThroughAccount(sync: AccountSync, action: RemoteAction): Promise<Preview> {
  const target = await sync.target();
  if (!target) throw new Error("NO_ACCOUNT_LINK");
  return sync.prepare(target, action);
}
