// "Try again" on an account the server stopped: one sign-in with the saved
// password. A server can refuse a good password for a while, so the owner
// may retry without typing it again; an accepted sign-in clears the stop.
import { imapConfigOf } from "./compose.ts";
import type { ImapGateway, MailStore, SecretVault } from "./ports.ts";

/**
 * resumed: the server accepted the saved password, sync is on again.
 * refused: it refused it again. unreachable: no answer about the password.
 * unreadable: the saved password cannot be opened.
 */
export type RetrySignInResult = "resumed" | "refused" | "unreachable" | "unreadable";

export type RetrySignInDeps = {
  store: MailStore;
  gateway: ImapGateway;
  /** Null while the credential key is not set. */
  vault: SecretVault | null;
  /** Runs work for an account behind its sync and its writes. */
  run: <T>(accountId: string, work: () => Promise<T>) => Promise<T>;
};

/** Null for an unknown account. An account that is not stopped is "resumed" without a sign-in. */
export async function retrySignIn(deps: RetrySignInDeps, accountId: string): Promise<RetrySignInResult | null> {
  const { store, vault } = deps;
  const account = store.getAccount(accountId);
  if (account === null) return null;
  if (!account.authFailed) return "resumed";
  if (vault === null) return "unreadable";
  let config;
  try {
    config = imapConfigOf(account, vault);
  } catch {
    return "unreadable";
  }
  return deps.run(accountId, async () => {
    let login;
    try {
      login = await deps.gateway.test(config);
    } catch {
      return "unreachable";
    }
    if (!login.ok) return login.authFailed ? "refused" : "unreachable";
    // The password may have been replaced while this waited for the account's queue.
    const now = store.getAccount(accountId);
    if (now === null || now.passwordSealed !== account.passwordSealed) return "resumed";
    if (now.authFailed) {
      store.recordSyncResult(accountId, { lastSyncAt: now.lastSyncAt, lastError: null, authFailed: false });
    }
    return "resumed";
  });
}
