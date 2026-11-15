import { beforeEach, describe, expect, it } from "vitest";
import type { NewAccountInput } from "./model.ts";
import { ImapAuthError, SendError, type ImapConfig, type ImapGateway, type SecretVault } from "./ports.ts";
import {
  AccountBusyError,
  addAccount,
  removeAccount,
  setSmtp,
  SmtpSettingsRefused,
  testAccount,
  testSmtp,
  toPublicAccount,
  type AccountDeps,
} from "./accounts.ts";
import {
  FakeTransport,
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
let transport: FakeTransport;
let deps: AccountDeps;
let ids: number;

function input(overrides: Partial<NewAccountInput> = {}): NewAccountInput {
  return { preset: "icloud", email: "owner@example.org", password: PASSWORD, ...overrides };
}

beforeEach(() => {
  store = new InMemoryMailStore();
  gateway = new ScriptedImapGateway({ uidValidity: 1, uidNext: 1, messages: [] });
  ids = 0;
  transport = new FakeTransport();
  deps = {
    store,
    gateway,
    vault: new MarkingVault(),
    clock: new FixedClock(new Date("2026-11-14T10:00:00.000Z")),
    newId: () => `acc_new_${++ids}`,
    transport,
  };
});

const OTHER_SMTP = {
  preset: "other" as const,
  host: "imap.example.org",
  smtpHost: "smtp.example.org",
  smtpPort: 465,
  smtpSecurity: "tls" as const,
};

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

  it("tests SMTP too for Other, with the IMAP password, and reports a kind only", async () => {
    expect(await testAccount(deps, input(OTHER_SMTP))).toEqual({ ok: true, reason: null });
    expect(transport.verified).toEqual([
      { host: "smtp.example.org", port: 465, security: "tls", username: "owner@example.org", password: PASSWORD },
    ]);
    transport.verifyError = new SendError("auth", false);
    expect(await testAccount(deps, input(OTHER_SMTP))).toEqual({ ok: false, reason: "SMTP sign-in refused" });
  });

  it("does not test SMTP for iCloud or Gmail, nor after an IMAP failure", async () => {
    await testAccount(deps, input());
    await testAccount(deps, input({ preset: "gmail" }));
    gateway.failOpen(new ImapAuthError());
    await testAccount(deps, input(OTHER_SMTP));
    expect(transport.verified).toEqual([]);
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
      smtpConfigured: true,
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
      input({ ...OTHER_SMTP, host: " imap.example.org ", port: 1993, username: "login" }),
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

describe("addAccount: SMTP", () => {
  it("fills SMTP from the iCloud and Gmail presets without testing it", async () => {
    await addAccount(deps, input());
    expect(store.getAccount("acc_new_1")).toMatchObject({
      smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls", username: null },
      sentCopy: "append",
    });
    await addAccount(deps, input({ preset: "gmail", email: "owner@example.com" }));
    expect(store.getAccount("acc_new_2")).toMatchObject({
      smtp: { host: "smtp.gmail.com", port: 465, security: "tls", username: null },
      sentCopy: "server",
    });
    expect(transport.verified).toEqual([]);
  });

  it("verifies Other's SMTP before saving, and saves nothing when it fails", async () => {
    transport.verifyError = new SendError("connect", false);
    await expect(addAccount(deps, input(OTHER_SMTP))).rejects.toThrow("Could not reach the SMTP server");
    expect(store.listAccounts()).toEqual([]);
    transport.verifyError = null;
    const account = await addAccount(deps, input({ ...OTHER_SMTP, smtpUsername: " smtp-login " }));
    expect(account.smtpConfigured).toBe(true);
    expect(store.getAccount(account.id)).toMatchObject({
      smtp: { host: "smtp.example.org", port: 465, security: "tls", username: "smtp-login" },
      sentCopy: "append",
    });
    expect(transport.verified.at(-1)?.username).toBe("smtp-login");
  });

  it("never puts the password or the server's reply into the reason", async () => {
    transport.verifyError = new Error(`535 rejected ${PASSWORD}`);
    await expect(addAccount(deps, input(OTHER_SMTP))).rejects.toThrow(/^SMTP failed$/);
  });
});

describe("testSmtp and setSmtp", () => {
  const settings = { accountId: "acc_x", host: " smtp.example.org ", port: 587, security: "starttls" as const };
  const STORED_SMTP = { host: "smtp.example.org", port: 465, security: "tls" as const, username: null };

  beforeEach(() => {
    store.saveAccount(
      makeStoredAccount({
        id: "acc_x",
        username: "imap-login",
        passwordSealed: new MarkingVault().seal(PASSWORD),
        smtp: STORED_SMTP,
      }),
    );
  });

  it("tests with the stored password and the IMAP username by default", async () => {
    expect(await testSmtp(deps, settings)).toEqual({ ok: true, reason: null });
    expect(transport.verified).toEqual([
      { host: "smtp.example.org", port: 587, security: "starttls", username: "imap-login", password: PASSWORD },
    ]);
    expect(store.getAccount("acc_x")!.smtp).toEqual(STORED_SMTP);
  });

  it("reports an unknown account and a refused login without echoing anything", async () => {
    expect(await testSmtp(deps, { ...settings, accountId: "nope" })).toEqual({
      ok: false,
      reason: "Account not found",
    });
    transport.verifyError = new SendError("tls", false);
    const result = await testSmtp(deps, settings);
    expect(result).toEqual({ ok: false, reason: "SMTP secure connection failed" });
  });

  it("setSmtp saves only after a passing test, keeping mail and the Sent policy", async () => {
    transport.verifyError = new SendError("auth", false);
    expect((await setSmtp(deps, settings)).ok).toBe(false);
    expect(store.getAccount("acc_x")!.smtp).toEqual(STORED_SMTP);
    transport.verifyError = null;
    expect(await setSmtp(deps, { ...settings, username: "smtp-login" })).toEqual({ ok: true, reason: null });
    expect(store.getAccount("acc_x")).toMatchObject({
      smtp: { host: "smtp.example.org", port: 587, security: "starttls", username: "smtp-login" },
      sentCopy: "append",
      passwordSealed: new MarkingVault().seal(PASSWORD),
    });
  });

  const OTHER_HOST = { ...settings, host: "smtp.attacker.example.net" };
  const recordingGateway = (accept: boolean) => {
    const tested: ImapConfig[] = [];
    const recording: ImapGateway = {
      test: async (config) => {
        tested.push(config);
        return accept ? { ok: true } : { ok: false, reason: `refused ${config.password}`, authFailed: true };
      },
      listFolders: (config) => gateway.listFolders(config),
      openFolder: (config, path, options) => gateway.openFolder(config, path, options),
    };
    return { tested, recording };
  };

  it("never sends the stored password to a host outside the account's domain or its stored SMTP host", async () => {
    for (const run of [testSmtp, setSmtp]) {
      const result = await run(deps, OTHER_HOST);
      expect(result).toEqual({ ok: false, reason: "Enter the account password to use this SMTP server", signInRequired: true });
    }
    expect(transport.verified).toEqual([]);
    expect(store.getAccount("acc_x")!.smtp).toEqual(STORED_SMTP);
  });

  it("only the stored SMTP host and the IMAP host itself need no password", async () => {
    store.saveAccount({
      ...store.getAccount("acc_x")!,
      smtp: { host: "relay.provider.example.com", port: 465, security: "tls", username: null },
    });
    for (const host of ["relay.provider.example.com", "RELAY.provider.example.com.", "imap.example.org", "IMAP.example.org."]) {
      expect((await testSmtp(deps, { ...settings, host })).ok, host).toBe(true);
    }
    for (const host of ["smtp.example.org", "example.org", "mail.out.example.org", "example.org.attacker.net", "badexample.org", "provider.example.com"]) {
      expect(await testSmtp(deps, { ...settings, host }), host).toMatchObject({ ok: false, signInRequired: true });
    }
    expect(transport.verified.every((c) => c.password === PASSWORD)).toBe(true);
  });

  it("no parent-domain trust: shared suffixes and IP neighbours need the password", async () => {
    const cases: [string, string][] = [
      ["example.co.uk", "evil.co.uk"],
      ["myhome.duckdns.org", "evil.duckdns.org"],
      ["box.mailhost.example", "attacker.mailhost.example"],
      ["192.168.1.10", "8.168.1.10"],
    ];
    for (const [imap, smtp] of cases) {
      store.saveAccount({ ...store.getAccount("acc_x")!, host: imap, smtp: null });
      expect(await testSmtp(deps, { ...settings, host: smtp }), `${imap} → ${smtp}`).toMatchObject({
        ok: false,
        signInRequired: true,
      });
    }
    expect(transport.verified).toEqual([]);
  });

  it("another host with the password: IMAP must accept it, SMTP gets that password, set stores it sealed", async () => {
    const typed = "typed-app-password";
    const { tested, recording } = recordingGateway(true);
    const d = { ...deps, gateway: recording };
    expect(await testSmtp(d, { ...OTHER_HOST, password: typed })).toEqual({ ok: true, reason: null });
    expect(tested).toEqual([{ host: "imap.example.org", port: 993, user: "imap-login", password: typed }]);
    expect(transport.verified.map((c) => [c.host, c.password])).toEqual([["smtp.attacker.example.net", typed]]);
    expect(store.getAccount("acc_x")!.passwordSealed).toBe(new MarkingVault().seal(PASSWORD));

    expect(await setSmtp(d, { ...OTHER_HOST, password: typed })).toEqual({ ok: true, reason: null });
    expect(store.getAccount("acc_x")).toMatchObject({
      smtp: { host: "smtp.attacker.example.net" },
      passwordSealed: new MarkingVault().seal(typed),
    });
  });

  it("a password IMAP refuses is never sent to SMTP nor stored, and never echoed", async () => {
    const { recording } = recordingGateway(false);
    const result = await setSmtp({ ...deps, gateway: recording }, { ...OTHER_HOST, password: "wrong-guess" });
    expect(result).toEqual({ ok: false, reason: "The IMAP server refused this password" });
    expect(JSON.stringify(result)).not.toContain("wrong-guess");
    expect(transport.verified).toEqual([]);
    expect(store.getAccount("acc_x")).toMatchObject({ smtp: STORED_SMTP, passwordSealed: new MarkingVault().seal(PASSWORD) });
  });

  it("iCloud and Gmail keep their preset SMTP server: any other value is refused", async () => {
    store.saveAccount(makeStoredAccount({ id: "acc_g", preset: "gmail", host: "imap.gmail.com", passwordSealed: new MarkingVault().seal(PASSWORD) }));
    const preset = { accountId: "acc_g", host: "smtp.gmail.com", port: 465, security: "tls" as const };
    expect((await setSmtp(deps, preset)).ok).toBe(true);
    for (const change of [{ host: "smtp.attacker.example.net" }, { port: 587 }, { security: "starttls" as const }]) {
      await expect(testSmtp(deps, { ...preset, ...change })).rejects.toThrow(SmtpSettingsRefused);
      await expect(setSmtp(deps, { ...preset, ...change, password: PASSWORD })).rejects.toThrow(/^This provider's SMTP server is fixed$/);
    }
    expect(transport.verified.map((c) => c.host)).toEqual(["smtp.gmail.com"]);
  });
});

describe("removeAccount", () => {
  it("removes an existing account and reports a missing one", () => {
    store.saveAccount(makeStoredAccount({ id: "acc_x" }));
    expect(removeAccount(deps, "acc_x")).toBe(true);
    expect(store.getAccount("acc_x")).toBeNull();
    expect(removeAccount(deps, "acc_x")).toBe(false);
  });

  it("is refused while a message of the account is being sent, and allowed once it settles", () => {
    store.saveAccount(makeStoredAccount({ id: "acc_x" }));
    store.queueOutbox(
      {
        id: "out_1",
        accountId: "acc_x",
        draftId: null,
        messageId: "<a@example.org>",
        subject: "Invented",
        envelopeFrom: "owner@example.org",
        envelopeTo: ["bob@example.com"],
        mime: new Uint8Array([1]),
        bccHeader: null,
        sendAfter: "2026-11-14T10:00:00.000Z",
        origin: "owner",
        createdAt: "2026-11-14T10:00:00.000Z",
      },
      0,
    );
    expect(store.claimDueOutbox("2026-11-14T10:00:10.000Z", [])?.id).toBe("out_1");
    expect(() => removeAccount(deps, "acc_x")).toThrow(AccountBusyError);
    expect(() => removeAccount(deps, "acc_x")).toThrow("A message is being sent");
    expect(store.getAccount("acc_x")).not.toBeNull();
    store.transitionOutbox("out_1", ["sending"], "failed", { errorKind: "connect" });
    expect(removeAccount(deps, "acc_x")).toBe(true);
    expect(store.listOutbox(null)).toEqual([]);
  });
});

describe("toPublicAccount", () => {
  it("toPublicAccount has no passwordSealed", () => {
    const stored = makeStoredAccount({ passwordSealed: "sealed-secret" });
    const account = toPublicAccount(stored);
    expect("passwordSealed" in account).toBe(false);
    expect(JSON.stringify(account)).not.toContain("sealed-secret");
    const { passwordSealed: _omitted, smtp: _smtp, sentCopy: _sentCopy, signature: _signature, ...rest } = stored;
    expect(account).toEqual({ ...rest, smtpConfigured: false });
  });

  it("toPublicAccount says whether SMTP is set, never its details", () => {
    const stored = makeStoredAccount({
      smtp: { host: "smtp.example.org", port: 465, security: "tls", username: "smtp-login" },
      sentCopy: "append",
    });
    const account = toPublicAccount(stored);
    expect(account.smtpConfigured).toBe(true);
    expect(Object.keys(account)).not.toEqual(expect.arrayContaining(["smtp"]));
    expect(JSON.stringify(account)).not.toContain("smtp-login");
  });
});
