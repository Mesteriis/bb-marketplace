// Account use cases: test a connection, add (or update) an account, remove
// one, and strip the sealed password before an account leaves the server.
// The password is used only for the connection test and sealing; it is never
// returned, stored in plain text, or put into an error message.
import type { Account, NewAccountInput, StoredAccount } from "./model.ts";
import type { Clock, ImapConfig, ImapGateway, MailStore, SecretVault } from "./ports.ts";
import { resolveServer } from "./presets.ts";

export type AccountDeps = {
  store: MailStore;
  gateway: ImapGateway;
  vault: SecretVault;
  clock: Clock;
  newId: () => string;
};

export type AccountTestResult = { ok: boolean; reason: string | null };

export async function testAccount(
  deps: AccountDeps,
  input: NewAccountInput,
): Promise<AccountTestResult> {
  let config: ImapConfig;
  try {
    config = configFor(input);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Invalid server" };
  }
  return runTest(deps.gateway, config);
}

/**
 * Tests the connection, then seals the password and saves the account. An
 * account with the same email keeps its id, creation time and sync history;
 * its auth failure and last error are cleared.
 */
export async function addAccount(deps: AccountDeps, input: NewAccountInput): Promise<Account> {
  const config = configFor(input);
  const result = await runTest(deps.gateway, config);
  if (!result.ok) throw new Error(result.reason ?? "Connection failed");
  const existing = deps.store.findAccountByEmail(input.email);
  const stored: StoredAccount = {
    id: existing?.id ?? deps.newId(),
    email: input.email,
    displayName:
      input.displayName !== undefined ? input.displayName : (existing?.displayName ?? null),
    preset: input.preset,
    host: config.host,
    port: config.port,
    username: config.user,
    createdAt: existing?.createdAt ?? deps.clock.now().toISOString(),
    lastSyncAt: existing?.lastSyncAt ?? null,
    lastError: null,
    authFailed: false,
    passwordSealed: deps.vault.seal(input.password),
    // SMTP is set up separately; re-adding an account keeps what it had.
    smtp: existing?.smtp ?? null,
    sentCopy: existing?.sentCopy ?? "append",
  };
  deps.store.saveAccount(stored);
  return toPublicAccount(stored);
}

/** Deletes the account and all its mail. False when there is no such account. */
export function removeAccount(deps: Pick<AccountDeps, "store">, id: string): boolean {
  if (deps.store.getAccount(id) === null) return false;
  deps.store.deleteAccount(id);
  return true;
}

export function toPublicAccount(stored: StoredAccount): Account {
  return {
    id: stored.id,
    email: stored.email,
    displayName: stored.displayName,
    preset: stored.preset,
    host: stored.host,
    port: stored.port,
    username: stored.username,
    createdAt: stored.createdAt,
    lastSyncAt: stored.lastSyncAt,
    lastError: stored.lastError,
    authFailed: stored.authFailed,
    smtpConfigured: stored.smtp !== null,
  };
}

function configFor(input: NewAccountInput): ImapConfig {
  const { host, port, username } = resolveServer(input);
  return { host, port, user: username, password: input.password };
}

async function runTest(gateway: ImapGateway, config: ImapConfig): Promise<AccountTestResult> {
  try {
    const result = await gateway.test(config);
    if (result.ok) return { ok: true, reason: null };
    return { ok: false, reason: redact(result.reason, config.password) };
  } catch {
    return { ok: false, reason: "Connection failed" };
  }
}

/** Defence in depth: gateways build reasons from codes, but never echo the password. */
function redact(text: string, password: string): string {
  return password === "" ? text : text.split(password).join("***");
}
