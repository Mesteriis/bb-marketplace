import { afterEach, describe, expect, it, vi } from "vitest";
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
      {
        log: (line) => {
          lines.push(line);
          throw new Error("logger broke"); // A throwing logger must not stop the round.
        },
      },
    );
    const controller = new AbortController();
    const done = loop.start(controller.signal);

    await vi.waitFor(() => expect(notifier.changes).toContain("acc_good"));
    controller.abort();
    await done;

    expect(getAccount("acc_bad")?.lastError).toBe("Sync failed");
    expect(getAccount("acc_sealed")?.lastError).toBe(DECRYPT_ERROR);
    expect(notifier.changes).toContain("acc_sealed");
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

  it("abort resolves start while an account sync is stuck", async () => {
    const { store, deps } = setup();
    store.saveAccount(account("acc_1"));
    let opened = false;
    const stuck: ImapGateway = {
      test: async () => ({ ok: true }),
      openInbox: () => {
        opened = true;
        return new Promise<InboxSession>(() => {});
      },
    };
    const loop = createSyncLoop({ ...deps, gateway: stuck }, SETTINGS);
    const controller = new AbortController();
    const done = loop.start(controller.signal);
    await vi.waitFor(() => expect(opened).toBe(true));

    const started = Date.now();
    controller.abort();
    await done;

    expect(Date.now() - started).toBeLessThan(100);
  });

  it("a wake during a round triggers another round", async () => {
    const { store, scripted, notifier, deps } = setup();
    store.saveAccount(account("acc_1"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let opens = 0;
    const gated: ImapGateway = {
      test: () => scripted.test(),
      openInbox: async (config, options) => {
        opens++;
        if (opens === 1) await gate;
        return scripted.openInbox(config, options);
      },
    };
    const loop = createSyncLoop({ ...deps, gateway: gated }, SETTINGS);
    const controller = new AbortController();
    const done = loop.start(controller.signal);
    await vi.waitFor(() => expect(opens).toBe(1));

    loop.wake("acc_1");
    release();

    await vi.waitFor(() => expect(notifier.changes).toEqual(["acc_1", "acc_1"]));
    controller.abort();
    await done;
  });

  describe("with fake timers", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a targeted wake does not delay the other accounts' round", async () => {
      vi.useFakeTimers();
      const { store, notifier, deps } = setup();
      store.saveAccount(account("acc_a"));
      store.saveAccount(account("acc_b"));
      const loop = createSyncLoop(deps, () => ({
        windowDays: 30,
        batchSize: 50,
        intervalMinutes: 1,
      }));
      const controller = new AbortController();
      const done = loop.start(controller.signal);
      const count = (id: string) => notifier.changes.filter((c) => c === id).length;
      await vi.advanceTimersByTimeAsync(0);
      expect([count("acc_a"), count("acc_b")]).toEqual([1, 1]);

      await vi.advanceTimersByTimeAsync(30_000);
      loop.wake("acc_a");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20_000);
      loop.wake("acc_a");
      await vi.advanceTimersByTimeAsync(0);
      expect([count("acc_a"), count("acc_b")]).toEqual([3, 1]);

      // The full round is still due one minute after the first, not after the last wake.
      await vi.advanceTimersByTimeAsync(10_500);
      expect([count("acc_a"), count("acc_b")]).toEqual([4, 2]);
      controller.abort();
      await done;
    });

    it("rounds are skipped while the vault is not ready, and run once it is", async () => {
      vi.useFakeTimers();
      const { store, notifier, deps } = setup();
      store.saveAccount(account("acc_1"));
      let ready = false;
      const loop = createSyncLoop(deps, SETTINGS, { isReady: () => ready });
      const controller = new AbortController();
      const done = loop.start(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(notifier.changes).toEqual([]);

      ready = true;
      loop.wake(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(notifier.changes).toEqual(["acc_1"]);
      controller.abort();
      await done;
    });
  });
});
