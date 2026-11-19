import { describe, expect, it } from "vitest";
import { ImapAuthError } from "./ports.ts";
import { retrySignIn, type RetrySignInDeps } from "./retry-sign-in.ts";
import {
  IdentityVault,
  InMemoryMailStore,
  imapError,
  makeStoredAccount,
  ScriptedImapGateway,
} from "./testing/fakes.ts";

const ACCOUNT_ID = "acc_1";
const SYNCED_AT = "2026-11-14T11:00:00.000Z";

function setup(patch: { authFailed: boolean; lastError: string | null }) {
  const store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount({ id: ACCOUNT_ID, passwordSealed: "invented-password", lastSyncAt: SYNCED_AT, ...patch }));
  const gateway = new ScriptedImapGateway({ uidValidity: 1, uidNext: 1, messages: [] });
  const queued: string[] = [];
  const deps: RetrySignInDeps = {
    store,
    gateway,
    vault: new IdentityVault(),
    run: (accountId, work) => {
      queued.push(accountId);
      return work();
    },
  };
  return { store, gateway, deps, queued };
}

const STOPPED = { authFailed: true, lastError: "Authentication failed" };

describe("retrySignIn", () => {
  it("resumes a stopped account when the server accepts the saved password", async () => {
    const { store, deps, queued } = setup(STOPPED);

    expect(await retrySignIn(deps, ACCOUNT_ID)).toBe("resumed");

    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({ authFailed: false, lastError: null, lastSyncAt: SYNCED_AT });
    expect(queued).toEqual([ACCOUNT_ID]);
  });

  it("keeps the account stopped when the server refuses again", async () => {
    const { store, gateway, deps } = setup(STOPPED);
    gateway.failOpen(new ImapAuthError());

    expect(await retrySignIn(deps, ACCOUNT_ID)).toBe("refused");

    expect(store.getAccount(ACCOUNT_ID)).toMatchObject(STOPPED);
  });

  it("keeps the account stopped when the server cannot be reached", async () => {
    const { store, gateway, deps } = setup(STOPPED);
    gateway.failOpen(imapError("NoConnection"));

    expect(await retrySignIn(deps, ACCOUNT_ID)).toBe("unreachable");

    expect(store.getAccount(ACCOUNT_ID)).toMatchObject(STOPPED);
  });

  it("does not sign in for an account that is not stopped, and keeps its last error", async () => {
    const { store, gateway, deps, queued } = setup({ authFailed: false, lastError: "Sync failed (NoConnection)" });
    gateway.failOpen(new ImapAuthError());

    expect(await retrySignIn(deps, ACCOUNT_ID)).toBe("resumed");

    expect(queued).toEqual([]);
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject({ authFailed: false, lastError: "Sync failed (NoConnection)" });
  });

  it("says so when the saved password cannot be read, and null for an unknown account", async () => {
    const { store, deps } = setup(STOPPED);

    expect(await retrySignIn({ ...deps, vault: null }, ACCOUNT_ID)).toBe("unreadable");
    expect(await retrySignIn(deps, "missing")).toBeNull();
    expect(store.getAccount(ACCOUNT_ID)).toMatchObject(STOPPED);
  });
});
