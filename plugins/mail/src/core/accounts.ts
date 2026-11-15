// Account use cases: test a connection, add (or update) an account, remove
// one, and strip the sealed password before an account leaves the server.
// The password is used only for the connection test and sealing; it is never
// returned, stored in plain text, or put into an error message.
import type { Account, NewAccountInput, SendErrorKind, SmtpSecurity, StoredAccount, StoredSmtp } from "./model.ts";
import {
  SendError,
  type Clock,
  type ImapConfig,
  type ImapGateway,
  type MailStore,
  type MailTransport,
  type SecretVault,
  type SmtpConfig,
} from "./ports.ts";
import { PRESETS, resolveServer, resolveSmtp } from "./presets.ts";

export type AccountDeps = {
  store: MailStore;
  gateway: ImapGateway;
  vault: SecretVault;
  clock: Clock;
  newId: () => string;
  transport: MailTransport;
};

/**
 * SMTP settings for an existing account. The stored password is used only
 * for a host the account already trusts (resolution 21); another host needs
 * `password`, which the IMAP server must accept first.
 */
export type SmtpSettingsInput = {
  accountId: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  /** The account password, typed for this call: needed for a host outside the account's domain. */
  password?: string;
};

export type SmtpTestResult = AccountTestResult & { signInRequired?: true };

/** Thrown for SMTP settings an account cannot take (an iCloud or Gmail account's server is fixed). */
export class SmtpSettingsRefused extends Error {
  constructor() {
    super("This provider's SMTP server is fixed");
    this.name = "SmtpSettingsRefused";
  }
}

const PASSWORD_REQUIRED = "Enter the account password to use this SMTP server";
const PASSWORD_REFUSED = "The IMAP server refused this password";

/** Thrown by removeAccount while a message of the account is being sent. */
export class AccountBusyError extends Error {
  constructor() {
    super("A message is being sent");
    this.name = "AccountBusyError";
  }
}

/** Fixed text per SMTP failure kind: never the server's reply. */
const SMTP_REASON: Partial<Record<SendErrorKind, string>> = {
  auth: "SMTP sign-in refused",
  tls: "SMTP secure connection failed",
  connect: "Could not reach the SMTP server",
  timeout_before_data: "The SMTP server did not answer",
  temporary: "The SMTP server is busy; try again later",
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
  const result = await runTest(deps.gateway, config);
  if (!result.ok || input.preset !== "other") return result;
  // Another server: its SMTP is part of the setup, so it is tested too.
  let smtp: SmtpConfig;
  try {
    smtp = smtpConfigFor(input, config);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Invalid SMTP server" };
  }
  return verifySmtp(deps.transport, smtp);
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
  const { smtp, sentCopy } = resolveSmtp(input);
  if (input.preset === "other") {
    const smtpResult = await verifySmtp(deps.transport, smtpConfigFor(input, config));
    if (!smtpResult.ok) throw new Error(smtpResult.reason ?? "SMTP failed");
  }
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
    smtp,
    sentCopy,
    signature: existing?.signature ?? null,
  };
  deps.store.saveAccount(stored);
  return toPublicAccount(stored);
}

/**
 * Deletes the account with its mail, drafts and outbox. False when there is
 * no such account; throws AccountBusyError while one of its messages is
 * being sent (or copied to Sent).
 */
export function removeAccount(deps: Pick<AccountDeps, "store">, id: string): boolean {
  if (deps.store.getAccount(id) === null) return false;
  if (deps.store.hasSendingOutbox(id)) throw new AccountBusyError();
  deps.store.deleteAccount(id);
  return true;
}

type SmtpDeps = Pick<AccountDeps, "store" | "vault" | "transport" | "gateway">;

/**
 * Tests the SMTP settings. Sends nothing. An iCloud or Gmail account keeps
 * its preset server (anything else throws SmtpSettingsRefused). The stored
 * password goes only to a host the account trusts: its stored SMTP host, or
 * one in its IMAP host's domain. Any other host needs the password typed in
 * this call; the account's IMAP server must accept it before SMTP gets it.
 * No reason ever carries a password.
 */
export async function testSmtp(deps: SmtpDeps, input: SmtpSettingsInput): Promise<SmtpTestResult> {
  const checked = await checkSmtp(deps, input);
  return checked.result;
}

/**
 * Tests, then saves the account's SMTP settings (its Sent-copy policy
 * stays). A typed password both servers accepted becomes the account's
 * stored password, sealed.
 */
export async function setSmtp(deps: SmtpDeps, input: SmtpSettingsInput): Promise<SmtpTestResult> {
  const checked = await checkSmtp(deps, input);
  if (!checked.result.ok || checked.settings === null) return checked.result;
  const account = deps.store.getAccount(input.accountId);
  if (account === null) return { ok: false, reason: "Account not found" };
  const stored: StoredSmtp = {
    host: checked.settings.host,
    port: checked.settings.port,
    security: checked.settings.security,
    username: input.username?.trim() || null,
  };
  const passwordSealed = checked.typed === null ? account.passwordSealed : deps.vault.seal(checked.typed);
  deps.store.saveAccount({ ...account, smtp: stored, passwordSealed });
  return { ok: true, reason: null };
}

async function checkSmtp(
  deps: SmtpDeps,
  input: SmtpSettingsInput,
): Promise<{ result: SmtpTestResult; settings: Omit<SmtpConfig, "password"> | null; typed: string | null }> {
  const fail = (result: SmtpTestResult) => ({ result, settings: null, typed: null });
  const account = deps.store.getAccount(input.accountId);
  if (account === null) return fail({ ok: false, reason: "Account not found" });
  let settings: Omit<SmtpConfig, "password">;
  try {
    settings = settingsOf(input, account);
  } catch {
    return fail({ ok: false, reason: "SMTP host is required" });
  }
  const preset = PRESETS[account.preset].smtp;
  if (
    preset !== null &&
    (normalizeHost(settings.host) !== preset.host || settings.port !== preset.port || settings.security !== preset.security)
  ) {
    throw new SmtpSettingsRefused();
  }
  if (preset !== null) settings = { ...settings, host: preset.host };
  const typed = input.password !== undefined && input.password !== "" ? input.password : null;
  let password: string;
  if (typed !== null) {
    const imap = await runTest(deps.gateway, {
      host: account.host,
      port: account.port,
      user: account.username,
      password: typed,
    });
    if (!imap.ok) return fail({ ok: false, reason: PASSWORD_REFUSED });
    password = typed;
  } else {
    if (preset === null && !hostTrusted(account, settings.host)) {
      return fail({ ok: false, reason: PASSWORD_REQUIRED, signInRequired: true });
    }
    try {
      password = deps.vault.open(account.passwordSealed);
    } catch {
      return fail({ ok: false, reason: "The stored password cannot be read" });
    }
  }
  const result = await verifySmtp(deps.transport, { ...settings, password });
  return result.ok ? { result, settings, typed } : fail(result);
}

/** Lower case, without a trailing dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * A host the stored password may go to: exactly the account's stored SMTP
 * host or its IMAP host. No sibling or parent-domain rule: without a
 * public-suffix list, "same parent domain" also matches strangers
 * (example.co.uk → evil.co.uk, x.duckdns.org → y.duckdns.org), so any other
 * host needs the password typed in the same call.
 */
export function hostTrusted(account: StoredAccount, host: string): boolean {
  const candidate = normalizeHost(host);
  if (account.smtp !== null && normalizeHost(account.smtp.host) === candidate) return true;
  return candidate === normalizeHost(account.host);
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

function settingsOf(input: SmtpSettingsInput, account: StoredAccount): Omit<SmtpConfig, "password"> {
  const host = input.host.trim();
  if (host === "") throw new Error("SMTP host is required");
  return {
    host,
    port: input.port,
    security: input.security,
    username: input.username?.trim() || account.username,
  };
}

function smtpConfigFor(input: NewAccountInput, imap: ImapConfig): SmtpConfig {
  const { smtp } = resolveSmtp(input);
  return {
    host: smtp.host,
    port: smtp.port,
    security: smtp.security,
    username: smtp.username ?? imap.user,
    password: imap.password,
  };
}

async function verifySmtp(transport: MailTransport, config: SmtpConfig): Promise<AccountTestResult> {
  try {
    await transport.verify(config);
    return { ok: true, reason: null };
  } catch (error) {
    const kind = error instanceof SendError ? error.kind : null;
    return { ok: false, reason: (kind !== null ? SMTP_REASON[kind] : undefined) ?? "SMTP failed" };
  }
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
