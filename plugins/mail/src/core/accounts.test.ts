import { beforeEach, describe, expect, it } from "vitest";
import type { NewAccountInput } from "./model.ts";
import { ImapAuthError, type ImapConfig, type ImapGateway, type SecretVault } from "./ports.ts";
import { addAccount, removeAccount, testAccount, toPublicAccount, type AccountDeps } from "./accounts.ts";
import {
  FixedClock,
  InMemoryMailStore,
  ScriptedImapGateway,
  makeStoredAccount,
} from "./testing/fakes.ts";

const PASSWORD = "invented-app-password";

/** Seals visibly, so a test can tell a sealed value from the plain one. */
class MarkingVault implements SecretVault {
  seal(plain: string): string {
    return `sealed(${[...plain].reverse().join("")})`;
  }
  open(sealed: string): string {
    return [...sealed.slice(7, -1)].reverse().join("");
  }
}

let store: InMemoryMailStore;
let gateway: ScriptedImapGateway;
let deps: AccountDeps;
let ids: number;

function input(overrides: Partial<NewAccountInput> = {}): NewAccountInput {
  return { preset: "icloud", email: "owner@example.org", password: PASSWORD, ...overrides };
}

beforeEach(() => {
  store = new InMemoryMailStore();
  gateway = new ScriptedImapGateway({ uidValidity: 1, uidNext: 1, messages: [] });
  ids = 0;
  deps = {
    store,
    gateway,
    vault: new MarkingVault(),
    clock: new FixedClock(new Date("2026-11-14T10:00:00.000Z")),
    newId: () => `acc_new_${++ids}`,
  };
});

describe("testAccount", () => {
  it("reports success", async () => {
    expect(await testAccount(deps, input())).toEqual({ ok: true, reason: null });
  });

  it("reports the gateway's reason", async () => {
    gateway.failOpen(new ImapAuthError());
    expect(await testAccount(deps, input())).toEqual({ ok: false, reason: "ImapAuthError" });
  });

  it("reports a missing host for Other", async () => {
    expect(await testAccount(deps, input({ preset: "other" }))).toEqual({
      ok: false,
      reason: "Server host is required",
    });
  });
});

describe("addAccount", () => {
  it("addAccount rejects when the connection test fails", async () => {
    gateway.failOpen(new ImapAuthError());
    await expect(addAccount(deps, input())).rejects.toThrow("ImapAuthError");
    expect(store.listAccounts()).toEqual([]);
  });

  it("addAccount stores only the sealed password", async () => {
    const account = await addAccount(deps, input({ displayName: "Owner" }));
    expect(account).toEqual({
      id: "acc_new_1",
      email: "owner@example.org",
      displayName: "Owner",
      preset: "icloud",
      host: "imap.mail.me.com",
      port: 993,
      username: "owner@example.org",
      createdAt: "2026-11-14T10:00:00.000Z",
      lastSyncAt: null,
      lastError: null,
      authFailed: false,
    });
    expect(JSON.stringify(account)).not.toContain(PASSWORD);
    const stored = store.getAccount("acc_new_1")!;
    expect(stored.passwordSealed).toBe(new MarkingVault().seal(PASSWORD));
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });

  it("addAccount tests the resolved server before saving", async () => {
    const tested: ImapConfig[] = [];
    const recording: ImapGateway = {
      test: async (config) => {
        tested.push(config);
        return { ok: true };
      },
      listFolders: (config) => gateway.listFolders(config),
      openFolder: (config, path, options) => gateway.openFolder(config, path, options),
    };
    await addAccount(
      { ...deps, gateway: recording },
      input({ preset: "other", host: " imap.example.org ", port: 1993, username: "login" }),
    );
    expect(tested).toEqual([
      { host: "imap.example.org", port: 1993, user: "login", password: PASSWORD },
    ]);
  });

  it("addAccount with an existing email keeps the id and clears authFailed", async () => {
    store.saveAccount(
      makeStoredAccount({
        id: "acc_old",
        email: "Owner@Example.org",
        displayName: "Kept",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSyncAt: "2026-11-01T00:00:00.000Z",
        authFailed: true,
        lastError: "Authentication failed",
        passwordSealed: "sealed(old)",
      }),
    );
    const account = await addAccount(deps, input());
    expect(account.id).toBe("acc_old");
    expect(account.authFailed).toBe(false);
    expect(account.lastError).toBeNull();
    expect(account.displayName).toBe("Kept");
    expect(account.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(account.lastSyncAt).toBe("2026-11-01T00:00:00.000Z");
    expect(store.listAccounts()).toHaveLength(1);
    expect(store.getAccount("acc_old")!.passwordSealed).toBe(new MarkingVault().seal(PASSWORD));
  });
});

describe("removeAccount", () => {
  it("removes an existing account and reports a missing one", () => {
    store.saveAccount(makeStoredAccount({ id: "acc_x" }));
    expect(removeAccount(deps, "acc_x")).toBe(true);
    expect(store.getAccount("acc_x")).toBeNull();
    expect(removeAccount(deps, "acc_x")).toBe(false);
  });
});

describe("toPublicAccount", () => {
  it("toPublicAccount has no passwordSealed", () => {
    const stored = makeStoredAccount({ passwordSealed: "sealed-secret" });
    const account = toPublicAccount(stored);
    expect("passwordSealed" in account).toBe(false);
    expect(JSON.stringify(account)).not.toContain("sealed-secret");
    const { passwordSealed: _omitted, ...rest } = stored;
    expect(account).toEqual(rest);
  });
});
