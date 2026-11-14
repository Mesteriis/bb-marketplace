import { describe, expect, it, vi } from "vitest";
import type { ImapConfig, ImapGateway, InboxSession } from "../../core/ports.ts";
import type { SyncDeps } from "../../core/sync.ts";
import {
  FixedClock,
  IdentityVault,
  InMemoryMailStore,
  makeStoredAccount,
  RecordingNotifier,
  ScriptedImapGateway,
} from "../../core/testing/fakes.ts";
import { DECRYPT_ERROR, createSyncLoop } from "./sync-service.ts";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const SETTINGS = () => ({ windowDays: 30, batchSize: 50, intervalMinutes: 5 });

/** Fails to open INBOX for one user, serves the shared mailbox for the rest. */
class OneBadUserGateway implements ImapGateway {
  constructor(
    private readonly inner: ScriptedImapGateway,
    private readonly badUser: string,
  ) {}
  test() {
    return this.inner.test();
  }
  openInbox(config: ImapConfig, options: { readOnly: boolean }): Promise<InboxSession> {
    if (config.user === this.badUser) return Promise.reject(new Error("connection dropped"));
    return this.inner.openInbox(config, options);
  }
}

function setup() {
  const store = new InMemoryMailStore();
  const scripted = new ScriptedImapGateway({ uidValidity: 1, uidNext: 1, messages: [] });
  scripted.deliver();
  const notifier = new RecordingNotifier();
  const deps: SyncDeps = {
    store,
    gateway: scripted,
    vault: new IdentityVault(),
    clock: new FixedClock(NOW),
    notifier,
  };
  return { store, scripted, notifier, deps };
}

function account(id: string, overrides: Parameters<typeof makeStoredAccount>[0] = {}) {
  return makeStoredAccount({
    id,
    email: `${id}@example.org`,
    username: `${id}@example.org`,
    ...overrides,
  });
}

describe("createSyncLoop", () => {
  it("one failing account does not stop the others", async () => {
    const { store, scripted, notifier, deps } = setup();
    store.saveAccount(account("acc_bad"));
    store.saveAccount(account("acc_throws"));
    store.saveAccount(account("acc_locked", { authFailed: true }));
    store.saveAccount(account("acc_sealed", { passwordSealed: "not-openable" }));
    store.saveAccount(account("acc_good"));
    const getAccount = store.getAccount.bind(store);
    vi.spyOn(store, "getAccount").mockImplementation((id) => {
      if (id === "acc_throws") throw new Error("database is locked");
      return getAccount(id);
    });
    const vault = new IdentityVault();
    const lines: string[] = [];
    const loop = createSyncLoop(
      {
        ...deps,
        gateway: new OneBadUserGateway(scripted, "acc_bad@example.org"),
        vault: {
          seal: (plain) => vault.seal(plain),
          open: (sealed) => {
            if (sealed === "not-openable") throw new Error("Cannot decrypt credential");
            return vault.open(sealed);
          },
        },
      },
      SETTINGS,
      (line) => lines.push(line),
    );
    const controller = new AbortController();
    const done = loop.start(controller.signal);

    await vi.waitFor(() => expect(notifier.changes).toContain("acc_good"));
    controller.abort();
    await done;

    expect(getAccount("acc_bad")?.lastError).toBe("Sync failed");
    expect(getAccount("acc_sealed")?.lastError).toBe(DECRYPT_ERROR);
    expect(getAccount("acc_good")?.lastError).toBeNull();
    // The auth-failed account is skipped: no session was opened with its user.
    expect(scripted.sessions.some((s) => s.config.user === "acc_locked@example.org")).toBe(false);
    expect(lines.join("\n")).not.toContain("sealed-password");
    expect(lines.join("\n")).not.toContain("not-openable");
  });

  it("wake starts a round before the interval", async () => {
    const { store, notifier, deps } = setup();
    store.saveAccount(account("acc_1"));
    const loop = createSyncLoop(deps, SETTINGS);
    const controller = new AbortController();
    const done = loop.start(controller.signal);
    await vi.waitFor(() => expect(notifier.changes).toEqual(["acc_1"]));

    loop.wake("acc_1");

    await vi.waitFor(() => expect(notifier.changes).toEqual(["acc_1", "acc_1"]), {
      timeout: 1000,
    });
    controller.abort();
    await done;
  });

  it("abort stops the loop promptly", async () => {
    const { store, notifier, deps } = setup();
    store.saveAccount(account("acc_1"));
    const loop = createSyncLoop(deps, SETTINGS);
    const controller = new AbortController();
    const done = loop.start(controller.signal);
    await vi.waitFor(() => expect(notifier.changes).toHaveLength(1));

    const started = Date.now();
    controller.abort();
    await done;

    expect(Date.now() - started).toBeLessThan(500);
    loop.wake(null); // A wake after the loop stopped is harmless.
    expect(notifier.changes).toHaveLength(1);
  });
});
