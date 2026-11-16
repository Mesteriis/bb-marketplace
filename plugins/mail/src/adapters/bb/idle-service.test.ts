import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_BACKOFF_MS,
  IDLE_STABLE_MS,
  IDLE_THROTTLED_MS,
  type ImapConfig,
  type ImapGateway,
  type WatchEnd,
} from "../../core/index.ts";
import { IdentityVault, InMemoryMailStore, makeStoredAccount } from "../../core/testing/fakes.ts";
import { createIdleSupervisor } from "./idle-service.ts";

type Call = {
  accountId: string;
  path: string;
  config: ImapConfig;
  onChange: (change: "exists" | "expunge" | "flags") => void;
  signal: AbortSignal;
  end: (result: WatchEnd) => void;
};

function setup(options: { enabled?: boolean; ready?: boolean } = {}) {
  const store = new InMemoryMailStore();
  const calls: Call[] = [];
  const gateway = {
    watchFolder: (config: ImapConfig, path: string, onChange: Call["onChange"], signal: AbortSignal) =>
      new Promise<WatchEnd>((resolve) => {
        const call: Call = { accountId: config.user.split("@")[0] ?? "", path, config, onChange, signal, end: resolve };
        calls.push(call);
        signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
      }),
  } as unknown as ImapGateway;
  const wakes: string[] = [];
  const lines: string[] = [];
  const settings = { enabled: options.enabled ?? true, ready: options.ready ?? true };
  const supervisor = createIdleSupervisor({
    gateway,
    store,
    vault: new IdentityVault(),
    wake: (accountId, wakeOptions) => wakes.push(`${accountId ?? "all"}${wakeOptions?.only === "inbox" ? " inbox" : ""}`),
    log: (line) => lines.push(line),
    enabled: () => settings.enabled,
    isReady: () => settings.ready,
    clock: { now: () => new Date() },
  });
  const addAccount = (id: string, overrides: Parameters<typeof makeStoredAccount>[0] = {}) => {
    store.saveAccount(makeStoredAccount({ id, email: `${id}@example.org`, username: `${id}@example.org`, ...overrides }));
    store.saveFolders(id, [
      { path: "Boxes/Incoming", name: "Incoming", delimiter: "/", specialUse: "inbox", selectable: true, subscribed: true },
      { path: "Archive", name: "Archive", delimiter: "/", specialUse: "archive", selectable: true, subscribed: true },
    ]);
  };
  const controller = new AbortController();
  return { store, calls, wakes, lines, settings, supervisor, addAccount, controller };
}

const live = (calls: Call[]) => calls.filter((call) => !call.signal.aborted);

describe("createIdleSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts an account's watch on its stored Inbox path only after its first ok round", async () => {
    const t = setup();
    t.addAccount("acc_1");
    const done = t.supervisor.start(t.controller.signal);
    expect(t.calls).toHaveLength(0);
    t.supervisor.firstRoundOk("acc_1");
    expect(t.calls.map((call) => call.path)).toEqual(["Boxes/Incoming"]);
    t.supervisor.firstRoundOk("acc_1");
    expect(t.calls).toHaveLength(1);
    expect(t.lines).toEqual(["idle acc_1: watching"]);
    t.controller.abort();
    await done;
  });

  it("debounces wakes per change kind: 1 s for new mail, 30 s for expunge and flags", async () => {
    const t = setup();
    t.addAccount("acc_1");
    const done = t.supervisor.start(t.controller.signal);
    t.supervisor.firstRoundOk("acc_1");
    const call = t.calls[0]!;
    call.onChange("exists");
    call.onChange("exists");
    call.onChange("flags");
    call.onChange("expunge");
    await vi.advanceTimersByTimeAsync(999);
    expect(t.wakes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.wakes).toEqual(["acc_1 inbox"]);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(t.wakes).toEqual(["acc_1 inbox", "acc_1 inbox", "acc_1 inbox"]);
    t.controller.abort();
    await done;
  });

  it("reconnects by the backoff sequence, waking an Inbox round after each reconnect, and resets after a stable watch", async () => {
    const t = setup();
    t.addAccount("acc_1");
    const done = t.supervisor.start(t.controller.signal);
    t.supervisor.firstRoundOk("acc_1");
    for (const [i, delay] of IDLE_BACKOFF_MS.entries()) {
      t.calls.at(-1)!.end({ kind: "dropped", code: "ETIMEOUT" });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.lines.at(-1)).toBe(`idle acc_1: dropped (ETIMEOUT) retry in ${delay / 1000}s`);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(t.calls).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.calls).toHaveLength(i + 2);
      expect(t.wakes.at(-1)).toBe("acc_1 inbox");
    }
    // The last delay repeats.
    t.calls.at(-1)!.end({ kind: "dropped", code: "ETIMEOUT" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.lines.at(-1)).toBe("idle acc_1: dropped (ETIMEOUT) retry in 900s");
    await vi.advanceTimersByTimeAsync(900_000);
    // A watch that lasted ten minutes resets the backoff.
    await vi.advanceTimersByTimeAsync(IDLE_STABLE_MS);
    t.calls.at(-1)!.end({ kind: "dropped", code: "ETIMEOUT" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.lines.at(-1)).toBe("idle acc_1: dropped (ETIMEOUT) retry in 5s");
    t.controller.abort();
    await done;
  });

  it("a throttled login waits 15 minutes", async () => {
    const t = setup();
    t.addAccount("acc_1");
    const done = t.supervisor.start(t.controller.signal);
    t.supervisor.firstRoundOk("acc_1");
    t.calls[0]!.end({ kind: "throttled" });
    await vi.advanceTimersByTimeAsync(IDLE_THROTTLED_MS - 1);
    expect(t.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls).toHaveLength(2);
    t.controller.abort();
    await done;
  });

  it("a refused login stops the watch and wakes one full round; it never retries until the password changes", async () => {
    const t = setup();
    t.addAccount("acc_1");
    const done = t.supervisor.start(t.controller.signal);
    t.supervisor.firstRoundOk("acc_1");
    t.calls[0]!.end({ kind: "auth" });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(t.calls).toHaveLength(1);
    expect(t.wakes).toEqual(["acc_1"]);
    expect(t.lines.at(-1)).toBe("idle acc_1: stopped");
    t.supervisor.refresh();
    expect(t.calls).toHaveLength(1);
    // A new password (sealed differently) lets it watch again.
    t.store.saveAccount({ ...t.store.getAccount("acc_1")!, passwordSealed: "sealed:new" });
    t.supervisor.refresh();
    expect(t.calls).toHaveLength(2);
    t.controller.abort();
    await done;
  });

  it("unsupported stops the watch until reload and logs it once", async () => {
    const t = setup();
    t.addAccount("acc_1");
    const done = t.supervisor.start(t.controller.signal);
    t.supervisor.firstRoundOk("acc_1");
    t.calls[0]!.end({ kind: "unsupported" });
    await vi.advanceTimersByTimeAsync(0);
    t.supervisor.refresh();
    t.supervisor.refresh();
    expect(t.calls).toHaveLength(1);
    expect(t.lines.filter((line) => line === "idle acc_1: unsupported")).toHaveLength(1);
    expect(t.wakes).toEqual([]);
    t.controller.abort();
    await done;
  });

  it("refresh follows the setting, the vault, authFailed, removed accounts and a changed password", async () => {
    const t = setup();
    t.addAccount("acc_1");
    t.addAccount("acc_2");
    const done = t.supervisor.start(t.controller.signal);
    t.supervisor.firstRoundOk("acc_1");
    t.supervisor.firstRoundOk("acc_2");
    expect(live(t.calls).map((call) => call.accountId)).toEqual(["acc_1", "acc_2"]);

    t.settings.enabled = false;
    t.supervisor.refresh();
    expect(live(t.calls)).toHaveLength(0);
    t.settings.enabled = true;
    t.supervisor.refresh();
    expect(live(t.calls)).toHaveLength(2);

    t.settings.ready = false;
    t.supervisor.refresh();
    expect(live(t.calls)).toHaveLength(0);
    t.settings.ready = true;
    t.supervisor.refresh();

    t.store.saveAccount({ ...t.store.getAccount("acc_2")!, authFailed: true });
    t.supervisor.refresh();
    expect(live(t.calls).map((call) => call.accountId)).toEqual(["acc_1"]);

    const before = t.calls.length;
    t.store.saveAccount({ ...t.store.getAccount("acc_1")!, passwordSealed: "sealed:other" });
    t.supervisor.refresh();
    expect(t.calls.length).toBe(before + 1);
    expect(live(t.calls)).toHaveLength(1);

    t.store.deleteAccount("acc_1");
    t.supervisor.refresh();
    expect(live(t.calls)).toHaveLength(0);
    t.controller.abort();
    await done;
  });

  it("an abort ends every watch and start resolves", async () => {
    const t = setup();
    t.addAccount("acc_1");
    t.addAccount("acc_2");
    const done = t.supervisor.start(t.controller.signal);
    t.supervisor.firstRoundOk("acc_1");
    t.supervisor.firstRoundOk("acc_2");
    t.controller.abort();
    await done;
    expect(t.calls.every((call) => call.signal.aborted)).toBe(true);
    t.supervisor.refresh();
    t.supervisor.firstRoundOk("acc_3");
    expect(t.calls).toHaveLength(2);
    expect(t.lines.join("\n")).not.toMatch(/@|Boxes|Incoming/);
  });
});
