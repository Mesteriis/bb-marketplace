import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_MAIL_OFF_MESSAGE,
  createMailPlugin,
  NEEDS_KEY_MESSAGE,
  PASSWORD_NEEDED_MESSAGE,
  PLUGIN_CALLER_MESSAGE,
  REMOVE_IN_THREAD_MESSAGE,
  renderSource,
} from "./server.ts";
import { MIGRATIONS, createSqliteStore } from "./src/adapters/bb/sqlite-store.ts";
import { createVault, generateVaultKey } from "./src/adapters/bb/vault.ts";
import { parseMail } from "./src/adapters/bb/imapflow-gateway.ts";
import {
  STALE_MESSAGE,
  TICKET_TTL_MS,
  TOO_LARGE_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from "./src/adapters/bb/downloads.ts";
import { ImapAuthError, MAIL_CHANGED_CHANNEL, UNTRUSTED_NOTICE } from "./src/core/index.ts";
import type {
  AccountPreset,
  FetchedMessage,
  Folder,
  MessageBody,
  MessageSummary,
  SpecialUse,
  ThreadDetail,
  ThreadSummary,
} from "./src/core/index.ts";
import {
  FixedClock,
  ScriptedImapGateway,
  imapError,
  makeFetchedMessage,
  makeStoredAccount,
} from "./src/core/testing/fakes.ts";
import type { FolderSession, ImapConfig } from "./src/core/index.ts";

const PLUGIN_ID = "makosh-mail";
const PASSWORD = "Pa55-word-never-leaks";
const NOW = new Date("2026-11-14T12:00:00.000Z");
const NEW_ACCOUNT = {
  preset: "other",
  email: "owner@example.org",
  host: "imap.example.org",
  port: 993,
  password: PASSWORD,
} as const;

type LoadOptions = {
  settings?: Record<string, string | number | boolean>;
  /** Wraps the bb handed to the plugin, to simulate a host that refuses writes. */
  wrap?: (bb: BbPluginApi) => BbPluginApi;
  /** Runs against the host's database before the plugin loads. */
  seed?: (bb: BbPluginApi) => void;
  /** Adjusts the scripted server before the plugin loads. */
  server?: (gateway: RawGateway) => void;
};

/**
 * The scripted server plus raw message bytes by folder and uid, served by
 * fetchRaw (recorded like the other session calls).
 */
class RawGateway extends ScriptedImapGateway {
  readonly raw = new Map<string, Uint8Array>();

  setRaw(path: string, uid: number, bytes: Uint8Array): void {
    this.raw.set(`${path}\u0000${uid}`, bytes);
  }

  override async openFolder(
    config: ImapConfig,
    path: string,
    options: { readOnly: boolean },
  ): Promise<FolderSession> {
    const session = await super.openFolder(config, path, options);
    const opened = this.sessions[this.sessions.length - 1]!;
    return {
      ...session,
      fetchRaw: async (uid, maxBytes) => {
        opened.calls.push({ method: "fetchRaw", uid });
        const bytes = this.raw.get(`${path}\u0000${uid}`);
        if (bytes === undefined) throw imapError("NotFound");
        if (bytes.byteLength > maxBytes) throw imapError("TooLarge");
        return bytes.slice();
      },
    };
  }
}

async function load(options: LoadOptions = {}) {
  const gateway = new RawGateway({ uidValidity: 3, uidNext: 1, messages: [] });
  gateway.deliver({
    subject: "Invented quarterly note",
    bodyText: "Invented body about the garden fence.",
    date: "2026-11-13T08:30:00.000Z",
  });
  options.server?.(gateway);
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    settings: options.settings ?? { vaultKey: generateVaultKey() },
    agentSkillIds: ["mail"],
  });
  const bb = options.wrap ? options.wrap(host.bb) : host.bb;
  options.seed?.(host.bb);
  const clock = new FixedClock(NOW);
  await createMailPlugin({ gateway, clock })(bb);
  return { ...host, gateway, clock };
}

/** A bb whose settings handles reject experimental_set, like a host that cannot write secrets. */
function refusingSettingsWrites(bb: BbPluginApi): BbPluginApi {
  const settings: BbPluginApi["settings"] = {
    define(descriptors) {
      const handle = bb.settings.define(descriptors);
      return {
        get: () => handle.get(),
        onChange: (listener) => handle.onChange(listener),
        experimental_set: () => Promise.reject(new Error("secret store unavailable")),
      };
    },
  };
  return new Proxy(bb, {
    get: (target, key) => (key === "settings" ? settings : Reflect.get(target, key)),
  });
}

type Host = Awaited<ReturnType<typeof load>>;

type SeedFolder = { path: string; name?: string; specialUse?: SpecialUse | null; selectable?: boolean };

const ICLOUD_FOLDERS: SeedFolder[] = [
  { path: "INBOX", specialUse: "inbox" },
  { path: "Junk", specialUse: "junk" },
  { path: "Archive", specialUse: "archive" },
  { path: "Deleted Messages", name: "Trash", specialUse: "trash" },
  { path: "Work" },
];

const GMAIL_FOLDERS: SeedFolder[] = [
  { path: "INBOX", specialUse: "inbox" },
  { path: "[Gmail]/Spam", specialUse: "junk" },
  { path: "[Gmail]/All Mail", specialUse: "all" },
  { path: "[Gmail]/Trash", specialUse: "trash" },
];

/** Stores an account (acc_1 by default) with folders and messages before the plugin loads. */
function seedMail(
  bb: BbPluginApi,
  seed: {
    accountId?: string;
    preset?: AccountPreset;
    folders: SeedFolder[];
    messages: { folder: string; message: FetchedMessage }[];
  },
): void {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createSqliteStore(db);
  const accountId = seed.accountId ?? "acc_1";
  const preset = seed.preset ?? "other";
  store.saveAccount(
    accountId === "acc_1"
      ? makeStoredAccount({ preset })
      : makeStoredAccount({
          id: accountId,
          email: `${accountId}@example.org`,
          username: `${accountId}@example.org`,
          preset,
        }),
  );
  store.saveFolders(
    accountId,
    seed.folders.map((f) => ({
      path: f.path,
      name: f.name ?? f.path.split("/").pop()!,
      delimiter: "/",
      specialUse: f.specialUse ?? null,
      selectable: f.selectable ?? true,
    })),
  );
  for (const { folder, message } of seed.messages) store.upsertMessages(accountId, folder, [message]);
}

/** A bb whose database refuses the snippet repair scan, as a corrupt row might. */
function failingSnippetRepair(bb: BbPluginApi): BbPluginApi {
  const storage: BbPluginApi["storage"] = new Proxy(bb.storage, {
    get(target, key) {
      if (key !== "database") return Reflect.get(target, key);
      return () => {
        const db = target.database();
        return new Proxy(db, {
          get(dbTarget, dbKey) {
            const value = Reflect.get(dbTarget, dbKey);
            if (dbKey !== "prepare") return typeof value === "function" ? value.bind(dbTarget) : value;
            return (sql: string) => {
              if (sql.includes("SELECT seq, snippet FROM messages")) {
                throw Object.assign(new Error("disk I/O error near 'Sale today'"), {
                  code: "SQLITE_IOERR",
                });
              }
              return dbTarget.prepare(sql);
            };
          },
        });
      };
    },
  });
  return new Proxy(bb, {
    get: (target, key) => (key === "storage" ? storage : Reflect.get(target, key)),
  });
}

function messageIdAt(host: Host, folder: string, uid: number): string {
  const row = host.bb.storage
    .database()
    .prepare("SELECT id FROM messages WHERE folder = ? AND uid = ?")
    .get(folder, uid) as { id: string } | undefined;
  return row!.id;
}

function movePending(host: Host, messageId: string): string | null {
  return (
    host.bb.storage.database().prepare("SELECT move_pending FROM messages WHERE id = ?").get(messageId) as {
      move_pending: string | null;
    }
  ).move_pending;
}

function action(host: Host, messageIds: string[], folder: string, kind: string) {
  return host.harness.behavior.callRpc("message_action", { messageIds, folder, action: kind });
}

/** A message_action result: one (account, source folder) group, queued with no error. */
function movedGroup(accountId: string, folder: string, queued: number, destination: string) {
  return { groups: [{ accountId, folder, queued, destination, error: null }] };
}

async function listThreads(host: Host, folder: string, accountId = "acc_1"): Promise<ThreadSummary[]> {
  const { threads } = (await host.harness.behavior.callRpc("threads_list", {
    scope: { kind: "account", accountId, folder },
    cursor: null,
    limit: 50,
  })) as { threads: ThreadSummary[] };
  return threads;
}

/** Adds the account and runs one sync round through the background service. */
async function addAndSync(host: Host): Promise<{ accountId: string; messageId: string }> {
  const { harness } = host;
  const account = (await harness.behavior.callRpc("accounts_add", NEW_ACCOUNT)) as { id: string };
  const service = harness.behavior.runService("sync");
  await vi.waitFor(async () => {
    const { hits } = (await harness.behavior.callRpc("search", {
      query: "quarterly",
      accountId: null,
      limit: 10,
    })) as { hits: MessageSummary[] };
    expect(hits).toHaveLength(1);
  });
  service.controller.abort();
  await service.done;
  const { hits } = (await harness.behavior.callRpc("search", {
    query: "quarterly",
    accountId: null,
    limit: 10,
  })) as { hits: MessageSummary[] };
  return { accountId: account.id, messageId: hits[0]!.id };
}

async function threadOf(host: Host, messageId: string): Promise<ThreadDetail> {
  const { hits } = (await host.harness.behavior.callRpc("search", {
    query: "quarterly",
    accountId: null,
    limit: 10,
  })) as { hits: MessageSummary[] };
  const hit = hits.find((h) => h.id === messageId)!;
  return (await host.harness.behavior.callRpc("thread_get", {
    threadId: hit.threadId,
    folder: "INBOX",
  })) as ThreadDetail;
}

function sealedPasswords(host: Host): string[] {
  return (
    host.bb.storage.database().prepare("SELECT password_sealed FROM accounts").all() as {
      password_sealed: string;
    }[]
  ).map((row) => row.password_sealed);
}

describe("makosh-mail server", () => {
  it("load repairs snippets stored before entities were fully decoded", async () => {
    const stale = "Sale &rarr; &zwnj; &zwnj; today";
    const host = await load({
      seed: (bb) => {
        const db = bb.storage.database();
        bb.storage.migrate(db, MIGRATIONS);
        const seeded = createSqliteStore(db);
        seeded.saveAccount(makeStoredAccount());
        seeded.upsertMessages("acc_1", "INBOX", [
          makeFetchedMessage(1, { bodyText: null, bodyHtml: "<p>Sale &rarr; &zwnj;&nbsp;today</p>" }),
        ]);
        db.prepare("UPDATE messages SET snippet = ?").run(stale);
      },
    });
    const db = host.bb.storage.database();
    expect((db.prepare("SELECT snippet FROM messages").get() as { snippet: string }).snippet).toBe(
      "Sale \u2192 today",
    );
    expect(host.harness.inspection.logEntries.map((e) => e.message)).toContain(
      "repaired 1 message snippets",
    );
  });

  it("generates and stores a vault key on first load", async () => {
    const host = await load({ settings: {} });

    let stored: string | undefined;
    await host.harness.lifecycle.reload(async (bb) => {
      const handle = bb.settings.define({
        vaultKey: { type: "string", label: "Credential encryption key", secret: true },
      });
      stored = (await handle.get()).vaultKey;
    });

    expect(stored).toBeDefined();
    expect(Buffer.from(stored!, "base64")).toHaveLength(32);
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([]);
  });

  it("reports needs configuration when the key cannot be written", async () => {
    const host = await load({ settings: {}, wrap: refusingSettingsWrites });

    expect(host.harness.inspection.needsConfigurationMessages).toEqual([NEEDS_KEY_MESSAGE]);
    const status = (await host.harness.behavior.callRpc("status_get", null)) as {
      vaultReady: boolean;
    };
    expect(status.vaultReady).toBe(false);
    await expect(
      host.harness.behavior.callRpc("sync_now", { accountId: null }),
    ).resolves.toEqual({ started: false });
  });

  it("reports needs configuration when the stored key is not a 32-byte key", async () => {
    const host = await load({ settings: { vaultKey: "dG9vLXNob3J0" } }); // gitleaks:allow (deliberately invalid key)

    expect(host.harness.inspection.needsConfigurationMessages).toEqual([NEEDS_KEY_MESSAGE]);
  });

  it("accounts_add refuses without a vault", async () => {
    const host = await load({ settings: {}, wrap: refusingSettingsWrites });

    await expect(host.harness.behavior.callRpc("accounts_add", NEW_ACCOUNT)).rejects.toThrow(
      NEEDS_KEY_MESSAGE,
    );
    expect(sealedPasswords(host)).toEqual([]);
  });

  it("status_get and accounts_list results contain no credential", async () => {
    const vaultKey = generateVaultKey();
    const host = await load({ settings: { vaultKey } });
    const added = await host.harness.behavior.callRpc("accounts_add", NEW_ACCOUNT);
    const { accountId } = await addAndSync(host);
    const [sealed] = sealedPasswords(host);
    expect(sealed).toBeTruthy();

    const outputs = [
      added,
      await host.harness.behavior.callRpc("status_get", null),
      await host.harness.behavior.callRpc("threads_list", {
        scope: { kind: "account", accountId, folder: "INBOX" },
        cursor: null,
        limit: 50,
      }),
      host.harness.inspection.realtimeSignals,
      host.harness.inspection.logEntries,
    ];
    const text = JSON.stringify(outputs);
    expect(text).toContain("owner@example.org");
    for (const secret of [PASSWORD, sealed!, vaultKey]) expect(text).not.toContain(secret);
  });

  it("message_open marks read and publishes mail-changed", async () => {
    const host = await load();
    const { accountId, messageId } = await addAndSync(host);
    const service = host.harness.behavior.runService("sync");
    const signalsBefore = host.harness.inspection.realtimeSignals.length;

    await expect(host.harness.behavior.callRpc("message_open", { messageId })).resolves.toEqual({
      ok: true,
    });

    expect(host.harness.inspection.realtimeSignals[signalsBefore]).toEqual({
      channel: MAIL_CHANGED_CHANNEL,
      payload: { accountId },
    });
    expect((await threadOf(host, messageId)).messages[0]!.isRead).toBe(true);
    // The wake makes the loop push \Seen to the server without waiting the interval.
    await vi.waitFor(() => expect(host.gateway.mailbox.messages[0]!.seen).toBe(true));
    service.controller.abort();
    await service.done;
  });

  it("message_open refuses an unknown message", async () => {
    const host = await load();

    await expect(
      host.harness.behavior.callRpc("message_open", { messageId: "missing" }),
    ).rejects.toThrow("Unknown message");
  });

  it("message_agent_text returns the untrusted text and does not mark the message read", async () => {
    const host = await load();
    const { messageId } = await addAndSync(host);

    const { text } = (await host.harness.behavior.callRpc("message_agent_text", { messageId })) as {
      text: string;
    };

    expect(text.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(text).toContain("garden fence");
    expect((await threadOf(host, messageId)).messages[0]!.isRead).toBe(false);
    await expect(
      host.harness.behavior.callRpc("message_agent_text", { messageId: "missing" }),
    ).rejects.toThrow("Unknown message");
  });

  it("sync_now does not start an account whose login was rejected", async () => {
    const host = await load();
    const { accountId } = await addAndSync(host);
    host.gateway.failOpen(new ImapAuthError());
    const service = host.harness.behavior.runService("sync");
    await host.harness.behavior.callRpc("sync_now", { accountId });
    await vi.waitFor(async () => {
      const status = (await host.harness.behavior.callRpc("status_get", null)) as {
        accounts: { authFailed: boolean }[];
      };
      expect(status.accounts[0]!.authFailed).toBe(true);
    });
    service.controller.abort();
    await service.done;

    await expect(host.harness.behavior.callRpc("sync_now", { accountId })).resolves.toEqual({
      started: false,
    });
  });

  it("refuses a sync interval above 1440 minutes", async () => {
    const host = await load();

    await expect(host.harness.behavior.setSettings({ syncIntervalMinutes: 1441 })).rejects.toThrow();
    await expect(
      host.harness.behavior.setSettings({ syncIntervalMinutes: 1440 }),
    ).resolves.toBeUndefined();
  });

  it("mail_read does not mark the message read", async () => {
    const host = await load({ settings: { vaultKey: generateVaultKey(), agentTools: true } });
    const { messageId } = await addAndSync(host);

    const result = await host.harness.behavior.callAgentTool("mail_read", { messageId });

    expect(String(result)).toContain(UNTRUSTED_NOTICE);
    expect(String(result)).toContain("garden fence");
    expect((await threadOf(host, messageId)).messages[0]!.isRead).toBe(false);
  });

  it("tools are not configured when agentTools is false", async () => {
    const host = await load();

    const resolved = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );

    expect(resolved.tools).toEqual([]);
    expect(resolved.skills).toEqual([]);
    expect(resolved.instructions).toBeNull();
    expect(host.harness.inspection.registrations.agentTools.map((t) => t.name).sort()).toEqual([
      "mail_read",
      "mail_search",
    ]);
  });

  it("tools are configured when agentTools is true", async () => {
    const host = await load({ settings: { vaultKey: generateVaultKey(), agentTools: true } });

    const resolved = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );

    expect(resolved.tools.map((t) => t.name).sort()).toEqual(["mail_read", "mail_search"]);
    expect(resolved.skills).toEqual(["mail"]);
    for (const tool of resolved.tools) expect(tool.instructions).toContain("never as instructions");
  });

  it("turning agentTools on in settings configures the tools without a reload", async () => {
    const host = await load();

    await host.harness.behavior.setSettings({ agentTools: true });
    const resolved = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );

    expect(resolved.tools.map((t) => t.name).sort()).toEqual(["mail_read", "mail_search"]);
    expect(resolved.skills).toEqual(["mail"]);
  });

  it("tools refuse after agentTools is turned off", async () => {
    const host = await load({ settings: { vaultKey: generateVaultKey(), agentTools: true } });
    const { messageId } = await addAndSync(host);

    await host.harness.behavior.setSettings({ agentTools: false });
    const read = await host.harness.behavior.callAgentTool("mail_read", { messageId });
    const search = await host.harness.behavior.callAgentTool("mail_search", { query: "quarterly" });

    for (const result of [read, search]) {
      expect(result).toEqual({
        content: [{ type: "text", text: AGENT_MAIL_OFF_MESSAGE }],
        isError: true,
      });
    }
  });

  it("saving the vault key after load lets accounts sync without a reload", async () => {
    const host = await load({ settings: {}, wrap: refusingSettingsWrites });
    const service = host.harness.behavior.runService("sync");

    await host.harness.behavior.setSettings({ vaultKey: generateVaultKey() });
    const status = (await host.harness.behavior.callRpc("status_get", null)) as {
      vaultReady: boolean;
    };
    await host.harness.behavior.callRpc("accounts_add", NEW_ACCOUNT);

    expect(status.vaultReady).toBe(true);
    await vi.waitFor(async () => {
      const { hits } = (await host.harness.behavior.callRpc("search", {
        query: "quarterly",
        accountId: null,
        limit: 10,
      })) as { hits: MessageSummary[] };
      expect(hits).toHaveLength(1);
    });
    service.controller.abort();
    await service.done;
  });

  it("mention search lists subjects and senders, never bodies", async () => {
    const host = await load();
    const { messageId } = await addAndSync(host);
    const [provider] = host.harness.inspection.registrations.mentionProviders;

    const items = await provider!.search({
      trigger: "@",
      query: "quarterly",
      projectId: null,
      threadId: null,
    });

    expect(provider!.id).toBe("mail");
    expect(provider!.label).toBe("Mail");
    expect(items).toEqual([
      expect.objectContaining({ id: messageId, title: "Invented quarterly note" }),
    ]);
    expect(items[0]!.subtitle).toBe("Sender <sender@example.org> · 2026-11-13 08:30 · INBOX");
    expect(JSON.stringify(items)).not.toContain("garden fence");
  });

  it("mention resolve returns the not-available context for an unknown id", async () => {
    const host = await load();
    const [provider] = host.harness.inspection.registrations.mentionProviders;

    expect(await provider!.resolve("missing")).toEqual({
      context: "This email is no longer available in Makosh Mail.",
    });
  });

  it("mention resolve gives the message text and does not mark it read", async () => {
    const host = await load();
    const { messageId } = await addAndSync(host);
    const [provider] = host.harness.inspection.registrations.mentionProviders;

    const { context } = await provider!.resolve(messageId);

    expect(context.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(context).toContain("garden fence");
    expect((await threadOf(host, messageId)).messages[0]!.isRead).toBe(false);
  });

  it("cli read prints the untrusted notice", async () => {
    const host = await load();
    const { messageId } = await addAndSync(host);

    const result = await host.harness.behavior.runCli(["read", messageId]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(result.stdout).toContain("garden fence");
    expect((await threadOf(host, messageId)).messages[0]!.isRead).toBe(false);
  });

  it("cli search, read and accounts refuse inside a thread when agentTools is off", async () => {
    const host = await load();
    const { messageId } = await addAndSync(host);
    const ctx = { threadId: "thread-1" };

    const search = await host.harness.behavior.runCli(["search", "quarterly"], ctx);
    const read = await host.harness.behavior.runCli(["read", messageId], ctx);
    const accounts = await host.harness.behavior.runCli(["accounts"], ctx);

    for (const result of [search, read, accounts]) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(AGENT_MAIL_OFF_MESSAGE);
      expect(result.stdout).not.toContain("garden fence");
      expect(result.stdout).not.toContain("quarterly");
      expect(result.stdout).not.toContain("owner@example.org");
    }
  });

  it("cli accounts works inside a thread when agentTools is on", async () => {
    const host = await load({ settings: { vaultKey: generateVaultKey(), agentTools: true } });
    await addAndSync(host);

    const result = await host.harness.behavior.runCli(["accounts"], { threadId: "thread-1" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("owner@example.org");
  });

  it("cli remove deletes an account from the owner's terminal only", async () => {
    const host = await load({ settings: { vaultKey: generateVaultKey(), agentTools: true } });
    const { accountId } = await addAndSync(host);

    const inThread = await host.harness.behavior.runCli(["remove", accountId], {
      threadId: "thread-1",
    });
    expect(inThread.exitCode).toBe(1);
    expect(inThread.stderr).toContain(REMOVE_IN_THREAD_MESSAGE);
    expect(sealedPasswords(host)).toHaveLength(1);

    const removed = await host.harness.behavior.runCli(["remove", accountId]);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toBe(`Removed ${accountId}.\n`);
    expect(sealedPasswords(host)).toEqual([]);
    expect(host.harness.inspection.realtimeSignals.at(-1)).toEqual({
      channel: MAIL_CHANGED_CHANNEL,
      payload: { accountId },
    });

    const again = await host.harness.behavior.runCli(["remove", accountId]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain(`unknown account '${accountId}'`);
  });

  it("cli read works inside a thread when agentTools is on", async () => {
    const host = await load();
    const { messageId } = await addAndSync(host);
    await host.harness.behavior.setSettings({ agentTools: true });

    const result = await host.harness.behavior.runCli(["read", messageId], { threadId: "thread-1" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("garden fence");
  });

  it("cli read works without a thread when agentTools is off", async () => {
    const host = await load();
    const { messageId } = await addAndSync(host);

    const result = await host.harness.behavior.runCli(["read", messageId]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("garden fence");
  });

  it("cli usage on bad input exits 1", async () => {
    const host = await load();

    const missing = await host.harness.behavior.runCli(["read"]);
    const unknown = await host.harness.behavior.runCli(["read", "missing"]);

    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Usage:");
    expect(unknown.exitCode).toBe(1);
  });

  it("cli output never contains the password", async () => {
    const vaultKey = generateVaultKey();
    const host = await load({ settings: { vaultKey } });
    const { accountId, messageId } = await addAndSync(host);
    const [sealed] = sealedPasswords(host);

    const results = await Promise.all(
      [
        ["accounts"],
        ["accounts", "--json"],
        ["search", "quarterly"],
        ["search", "quarterly", "--json"],
        ["read", messageId],
        ["read", messageId, "--json"],
        ["sync"],
        ["sync", accountId, "--json"],
      ].map((argv) => host.harness.behavior.runCli(argv)),
    );

    expect(results.map((r) => r.exitCode)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const text = JSON.stringify(results);
    expect(text).toContain("owner@example.org");
    for (const secret of [PASSWORD, sealed!, vaultKey]) expect(text).not.toContain(secret);
  });

  // -------------------------------------------------------------------------
  // Slice 2: folders, actions, images, agent surfaces
  // -------------------------------------------------------------------------

  it("load goes on when the snippet repair throws", async () => {
    const host = await load({ wrap: failingSnippetRepair });

    const messages = host.harness.inspection.logEntries.map((e) => e.message);
    expect(messages).toContain("snippet repair failed (Error SQLITE_IOERR)");
    expect(JSON.stringify(messages)).not.toContain("Sale today");
    expect(host.harness.inspection.registrations.rpcMethods).toContain("message_action");
    await expect(host.harness.behavior.callRpc("status_get", null)).resolves.toMatchObject({
      vaultReady: true,
    });
  });

  it("folders_list returns the account's folders in system order", async () => {
    const host = await load({ seed: (bb) => seedMail(bb, { folders: ICLOUD_FOLDERS, messages: [] }) });

    const { folders, roles } = (await host.harness.behavior.callRpc("folders_list", {
      accountId: "acc_1",
    })) as { folders: Folder[]; roles: unknown[] };

    // Merged role counts come only with All accounts (accountId null).
    expect(roles).toEqual([]);

    expect(folders.map((f) => f.path)).toEqual(["INBOX", "Junk", "Archive", "Deleted Messages", "Work"]);
    expect(folders[0]).toMatchObject({ unreadCount: 0, totalCount: 0, specialUse: "inbox" });
  });

  it("threads_list lists only threads with messages in the folder", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [
            { folder: "INBOX", message: makeFetchedMessage(1, { subject: "In inbox" }) },
            { folder: "Work", message: makeFetchedMessage(2, { subject: "At work" }) },
          ],
        }),
    });

    expect((await listThreads(host, "INBOX")).map((t) => t.subject)).toEqual(["In inbox"]);
    expect((await listThreads(host, "Work")).map((t) => t.subject)).toEqual(["At work"]);
  });

  it("status_get counts unread messages in Inbox folders only", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [
            { folder: "INBOX", message: makeFetchedMessage(1) },
            { folder: "Work", message: makeFetchedMessage(2) },
          ],
        }),
    });

    await expect(host.harness.behavior.callRpc("status_get", null)).resolves.toMatchObject({
      unreadCount: 1,
    });
  });

  it("message_action queues a move and hides the message", async () => {
    const host = await load({
      server: (gateway) => gateway.addFolder({ path: "Junk", specialUse: "junk" }),
    });
    const { accountId, messageId } = await addAndSync(host);
    const signalsBefore = host.harness.inspection.realtimeSignals.length;

    await expect(
      host.harness.behavior.callRpc("message_action", {
        messageIds: [messageId],
        folder: "INBOX",
        action: "spam",
      }),
    ).resolves.toEqual(movedGroup(accountId, "INBOX", 1, "Junk"));

    expect(host.harness.inspection.realtimeSignals[signalsBefore]).toEqual({
      channel: MAIL_CHANGED_CHANNEL,
      payload: { accountId },
    });
    expect(await listThreads(host, "INBOX", accountId)).toEqual([]);
    // The wake pushes the move to the server without waiting the interval.
    const service = host.harness.behavior.runService("sync");
    await vi.waitFor(() => {
      expect(host.gateway.mailbox.messages).toHaveLength(0);
      expect(host.gateway.mailboxes.get("Junk")!.messages).toHaveLength(1);
    });
    service.controller.abort();
    await service.done;
    expect((await listThreads(host, "Junk", accountId)).map((t) => t.subject)).toEqual([
      "Invented quarterly note",
    ]);
  });

  it("delete moves to Trash", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [{ folder: "Work", message: makeFetchedMessage(1) }],
        }),
    });
    const id = messageIdAt(host, "Work", 1);

    await expect(action(host, [id], "Work", "delete")).resolves.toEqual(
      movedGroup("acc_1", "Work", 1, "Trash"),
    );
    expect(movePending(host, id)).toBe("Deleted Messages");
  });

  it("archive on gmail moves INBOX copies to All Mail", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          preset: "gmail",
          folders: GMAIL_FOLDERS,
          messages: [
            { folder: "INBOX", message: makeFetchedMessage(1, { gmMsgId: "77" }) },
            { folder: "[Gmail]/All Mail", message: makeFetchedMessage(9, { gmMsgId: "77" }) },
          ],
        }),
    });
    const inbox = messageIdAt(host, "INBOX", 1);
    const allMail = messageIdAt(host, "[Gmail]/All Mail", 9);

    await expect(action(host, [inbox], "INBOX", "archive")).resolves.toEqual(
      movedGroup("acc_1", "INBOX", 1, "All Mail"),
    );
    expect(movePending(host, inbox)).toBe("[Gmail]/All Mail");
    expect(movePending(host, allMail)).toBeNull();
    await expect(action(host, [allMail], "[Gmail]/All Mail", "archive")).rejects.toThrow(
      "Already archived",
    );
  });

  it("not_spam outside Spam is refused", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [
            { folder: "INBOX", message: makeFetchedMessage(1) },
            { folder: "Junk", message: makeFetchedMessage(2) },
          ],
        }),
    });
    const inbox = messageIdAt(host, "INBOX", 1);
    const junk = messageIdAt(host, "Junk", 2);

    await expect(action(host, [inbox], "INBOX", "not_spam")).rejects.toThrow(
      "Not spam works only in Spam",
    );
    expect(movePending(host, inbox)).toBeNull();
    await expect(action(host, [junk], "Junk", "not_spam")).resolves.toEqual(
      movedGroup("acc_1", "Junk", 1, "INBOX"),
    );
  });

  it("message_action refuses what it cannot move and changes nothing", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: [
            { path: "INBOX", specialUse: "inbox" },
            { path: "Trash", specialUse: "trash", selectable: false },
            { path: "Work" },
          ],
          messages: [
            { folder: "INBOX", message: makeFetchedMessage(1) },
            { folder: "INBOX", message: makeFetchedMessage(2) },
            { folder: "Work", message: makeFetchedMessage(3) },
          ],
        }),
    });
    const [one, two] = [messageIdAt(host, "INBOX", 1), messageIdAt(host, "INBOX", 2)];
    const work = messageIdAt(host, "Work", 3);
    const signalsBefore = host.harness.inspection.realtimeSignals.length;

    await expect(action(host, [one], "INBOX", "spam")).rejects.toThrow(
      "This account has no Spam folder",
    );
    await expect(action(host, [one], "INBOX", "archive")).rejects.toThrow(
      "This account has no Archive folder",
    );
    await expect(action(host, [one], "INBOX", "delete")).rejects.toThrow(
      "Trash cannot hold messages",
    );
    await expect(action(host, [one, work], "INBOX", "not_spam")).rejects.toThrow(
      "Not spam works only in Spam",
    );
    await expect(action(host, [work], "INBOX", "delete")).rejects.toThrow(
      "These messages are not all in INBOX",
    );
    await expect(action(host, ["missing"], "INBOX", "delete")).rejects.toThrow("Unknown message");
    expect([one, two, work].map((id) => movePending(host, id))).toEqual([null, null, null]);
    expect(host.harness.inspection.realtimeSignals.length).toBe(signalsBefore);
  });

  it("message_action refuses a batch spanning folders or already moving", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [
            { folder: "INBOX", message: makeFetchedMessage(1) },
            { folder: "INBOX", message: makeFetchedMessage(2) },
            { folder: "Work", message: makeFetchedMessage(3) },
          ],
        }),
    });
    const [one, two] = [messageIdAt(host, "INBOX", 1), messageIdAt(host, "INBOX", 2)];
    const work = messageIdAt(host, "Work", 3);

    await expect(action(host, [one, work], "INBOX", "delete")).rejects.toThrow(
      "These messages are not all in INBOX",
    );
    expect(movePending(host, one)).toBeNull();
    await expect(action(host, [one], "INBOX", "delete")).resolves.toEqual(
      movedGroup("acc_1", "INBOX", 1, "Trash"),
    );
    await expect(action(host, [one, two], "INBOX", "delete")).rejects.toThrow(
      "These messages are not all in INBOX",
    );
    expect(movePending(host, two)).toBeNull();
    await expect(action(host, [work], "Work", "archive")).resolves.toEqual(
      movedGroup("acc_1", "Work", 1, "Archive"),
    );
    await expect(action(host, [two], "INBOX", "spam")).resolves.toEqual(
      movedGroup("acc_1", "INBOX", 1, "Junk"),
    );
  });

  it("message_action refuses a move into the folder the messages are in", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [{ folder: "Junk", message: makeFetchedMessage(1) }],
        }),
    });
    const id = messageIdAt(host, "Junk", 1);

    await expect(action(host, [id], "Junk", "spam")).rejects.toThrow("Already in Junk");
    expect(movePending(host, id)).toBeNull();
  });

  it("write methods refuse other plugins and change nothing", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [{ folder: "INBOX", message: makeFetchedMessage(1) }],
        }),
    });
    const messageId = messageIdAt(host, "INBOX", 1);
    const asPlugin = { experimental_caller: { kind: "plugin", pluginId: "other" } } as const;
    const call = (method: string, input: unknown) =>
      host.harness.behavior.callRpc(method, input, asPlugin);

    const unreadBefore = ((await call("status_get", null)) as { unreadCount: number }).unreadCount;
    const calls = [
      call("message_open", { messageId }),
      call("message_action", { messageIds: [messageId], folder: "INBOX", action: "delete" }),
      call("images_allow_sender", { messageId }),
      call("images_disallow_sender", { accountId: "acc_1", address: "sender@example.org" }),
      call("accounts_remove", { accountId: "acc_1" }),
      call("accounts_add", NEW_ACCOUNT),
      call("download_ticket", { kind: "eml", messageId }),
      call("download_ticket", { kind: "attachment", messageId, partId: "1" }),
      call("message_source", { messageId }),
      ...["mark_read", "mark_unread", "flag", "unflag"].map((kind) =>
        call("message_action", { messageIds: [messageId], folder: "INBOX", action: kind }),
      ),
      call("message_action", { messageIds: [messageId], role: "inbox", action: "flag" }),
      call("message_action", {
        messageIds: [messageId],
        folder: "INBOX",
        action: "move",
        destination: "Work",
      }),
    ];
    for (const result of calls) await expect(result).rejects.toThrow(PLUGIN_CALLER_MESSAGE);

    expect(movePending(host, messageId)).toBeNull();
    expect(((await call("status_get", null)) as { unreadCount: number }).unreadCount).toBe(unreadBefore);
    expect(sealedPasswords(host)).toEqual(["sealed-password"]);
    const body = (await call("message_body", { messageId })) as MessageBody;
    expect(body.remoteImagesAllowed).toBe(false);
  });

  it("message_action refuses while the password needs re-entering", async () => {
    const host = await load({
      seed: (bb) => {
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [{ folder: "INBOX", message: makeFetchedMessage(1) }],
        });
        createSqliteStore(bb.storage.database()).recordSyncResult("acc_1", {
          lastSyncAt: null,
          lastError: "Authentication failed",
          authFailed: true,
        });
      },
    });
    const messageId = messageIdAt(host, "INBOX", 1);

    await expect(action(host, [messageId], "INBOX", "delete")).rejects.toThrow(
      PASSWORD_NEEDED_MESSAGE,
    );
    expect(movePending(host, messageId)).toBeNull();
  });

  it("message_action refuses without a credential key", async () => {
    const host = await load({
      settings: {},
      wrap: refusingSettingsWrites,
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [{ folder: "INBOX", message: makeFetchedMessage(1) }],
        }),
    });
    const messageId = messageIdAt(host, "INBOX", 1);

    await expect(action(host, [messageId], "INBOX", "delete")).rejects.toThrow(NEEDS_KEY_MESSAGE);
    expect(movePending(host, messageId)).toBeNull();
  });

  it("actions are not exposed as tools or CLI", async () => {
    const host = await load({ settings: { vaultKey: generateVaultKey(), agentTools: true } });
    const { registrations } = host.harness.inspection;

    expect(registrations.rpcMethods).toEqual(
      expect.arrayContaining([
        "message_action",
        "images_allow_sender",
        "images_disallow_sender",
        "message_source",
        "download_ticket",
      ]),
    );
    // No RPC method is published to agents as discoverable.
    expect(registrations.experimental_publishedRpcMethods).toEqual([]);
    expect(registrations.agentTools.map((t) => t.name).sort()).toEqual(["mail_read", "mail_search"]);
    const resolved = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );
    expect(resolved.tools.map((t) => t.name).sort()).toEqual(["mail_read", "mail_search"]);
    expect(registrations.cli!.commands.map((c) => c.name).sort()).toEqual([
      "accounts",
      "read",
      "remove",
      "search",
      "sync",
    ]);
    expect(registrations.mentionProviders.map((p) => p.id)).toEqual(["mail"]);
  });

  it("message_body inlines cid images as data URLs and never other mime types", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [
            {
              folder: "INBOX",
              message: makeFetchedMessage(1, {
                bodyHtml:
                  '<img src="cid:logo@x"><img src="cid:vector@x"><img src="cid:nowhere@x">' +
                  '<td style="background:url(cid:bg@x)"></td>',
                inlineParts: [
                  { contentId: "logo@x", mimeType: "image/png", data: png },
                  { contentId: "vector@x", mimeType: "image/svg+xml", data: png },
                  { contentId: "bg@x", mimeType: "image/jpeg", data: png },
                ],
              }),
            },
          ],
        }),
    });
    const messageId = messageIdAt(host, "INBOX", 1);

    const body = (await host.harness.behavior.callRpc("message_body", { messageId })) as MessageBody;

    expect(body.html).toBe(
      '<img src="data:image/png;base64,AQID"><img src="cid:vector@x"><img src="cid:nowhere@x">' +
        '<td style="background:url(data:image/jpeg;base64,AQID)"></td>',
    );
    expect(body.remoteImagesAllowed).toBe(false);
    await expect(
      host.harness.behavior.callRpc("message_body", { messageId: "missing" }),
    ).rejects.toThrow("Unknown message");
  });

  it("images allowlist round trip", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: ICLOUD_FOLDERS,
          messages: [
            {
              folder: "INBOX",
              message: makeFetchedMessage(1, { from: { name: "News", address: "News@Example.org" } }),
            },
          ],
        }),
    });
    const messageId = messageIdAt(host, "INBOX", 1);
    const allowed = async () =>
      ((await host.harness.behavior.callRpc("message_body", { messageId })) as MessageBody)
        .remoteImagesAllowed;

    expect(await allowed()).toBe(false);
    await expect(
      host.harness.behavior.callRpc("images_allow_sender", { messageId }),
    ).resolves.toEqual({ address: "News@Example.org" });
    expect(await allowed()).toBe(true);
    await expect(
      host.harness.behavior.callRpc("images_disallow_sender", {
        accountId: "acc_1",
        address: "news@example.org",
      }),
    ).resolves.toEqual({ removed: true });
    expect(await allowed()).toBe(false);
    await expect(
      host.harness.behavior.callRpc("images_disallow_sender", {
        accountId: "acc_1",
        address: "news@example.org",
      }),
    ).resolves.toEqual({ removed: false });
    await expect(
      host.harness.behavior.callRpc("images_allow_sender", { messageId: "missing" }),
    ).rejects.toThrow("Unknown message");
  });

  it("agent text shows the folder", async () => {
    const host = await load({
      settings: { vaultKey: generateVaultKey(), agentTools: true },
      seed: (bb) =>
        seedMail(bb, {
          preset: "gmail",
          folders: GMAIL_FOLDERS,
          messages: [
            {
              folder: "[Gmail]/Spam",
              message: makeFetchedMessage(1, { subject: "Invented prize", bodyText: "Invented win" }),
            },
          ],
        }),
    });
    const messageId = messageIdAt(host, "[Gmail]/Spam", 1);
    const [provider] = host.harness.inspection.registrations.mentionProviders;

    const outputs = [
      ((await host.harness.behavior.callRpc("message_agent_text", { messageId })) as { text: string })
        .text,
      String(await host.harness.behavior.callAgentTool("mail_read", { messageId })),
      String(await host.harness.behavior.callAgentTool("mail_search", { query: "prize" })),
      (await provider!.resolve(messageId)).context,
      (await host.harness.behavior.runCli(["read", messageId])).stdout,
      (await host.harness.behavior.runCli(["search", "prize"])).stdout,
    ];

    for (const text of outputs) expect(text).toMatch(/(^|\n) *Folder: Spam\n/);
    const items = await provider!.search({ trigger: "@", query: "prize", projectId: null, threadId: null });
    expect(items[0]!.subtitle).toMatch(/ · Spam$/);
  });
});

/** Ids of the rows in `folder` of `accountId`, by uid. */
function idsIn(host: Host, accountId: string, folder: string): string[] {
  return (
    host.bb.storage
      .database()
      .prepare("SELECT id FROM messages WHERE account_id = ? AND folder = ? ORDER BY uid")
      .all(accountId, folder) as { id: string }[]
  ).map((row) => row.id);
}

function desired(host: Host, messageId: string): { seen: number | null; flagged: number | null; read: number } {
  return host.bb.storage
    .database()
    .prepare("SELECT seen_desired AS seen, flag_desired AS flagged, is_read AS read FROM messages WHERE id = ?")
    .get(messageId) as { seen: number | null; flagged: number | null; read: number };
}

function messages(count: number, from = 1): FetchedMessage[] {
  return Array.from({ length: count }, (_, i) => makeFetchedMessage(from + i));
}

/** acc_1 (iCloud folders) and acc_2 (an INBOX and Work), each with messages in INBOX. */
function seedTwoAccounts(bb: BbPluginApi, perAccount = 2): void {
  seedMail(bb, {
    folders: ICLOUD_FOLDERS,
    messages: [
      ...messages(perAccount).map((message) => ({ folder: "INBOX", message })),
      { folder: "Work", message: makeFetchedMessage(500) },
    ],
  });
  seedMail(bb, {
    accountId: "acc_2",
    folders: [{ path: "INBOX", specialUse: "inbox" }, { path: "Work" }, { path: "Trash", specialUse: "trash" }],
    messages: messages(perAccount, 1000).map((message) => ({ folder: "INBOX", message })),
  });
}

describe("makosh-mail server: bulk actions", () => {
  it("groups a role batch by account and source folder and sets the desired flags", async () => {
    const host = await load({ seed: (bb) => seedTwoAccounts(bb) });
    const [a1, a2] = idsIn(host, "acc_1", "INBOX");
    const [b1] = idsIn(host, "acc_2", "INBOX");
    const [work] = idsIn(host, "acc_1", "Work");
    const signalsBefore = host.harness.inspection.realtimeSignals.length;

    const result = await host.harness.behavior.callRpc("message_action", {
      messageIds: [a1, b1, work, a2],
      role: "inbox",
      action: "flag",
    });

    expect(result).toEqual({
      groups: [
        { accountId: "acc_1", folder: "INBOX", queued: 2, destination: null, error: null },
        { accountId: "acc_2", folder: "INBOX", queued: 1, destination: null, error: null },
        {
          accountId: "acc_1",
          folder: "Work",
          queued: 0,
          destination: null,
          error: "These messages are no longer in Inbox",
        },
      ],
    });
    expect([a1, a2, b1].map((id) => desired(host, id!).flagged)).toEqual([1, 1, 1]);
    expect(desired(host, work!).flagged).toBeNull();
    expect(host.harness.inspection.realtimeSignals.slice(signalsBefore)).toEqual([
      { channel: MAIL_CHANGED_CHANNEL, payload: { accountId: "acc_1" } },
      { channel: MAIL_CHANGED_CHANNEL, payload: { accountId: "acc_2" } },
    ]);
  });

  it("groups a 200-id mix across accounts", async () => {
    const host = await load({ seed: (bb) => seedTwoAccounts(bb, 100) });
    const ids = [...idsIn(host, "acc_1", "INBOX"), ...idsIn(host, "acc_2", "INBOX")];
    expect(ids).toHaveLength(200);

    const { groups } = (await host.harness.behavior.callRpc("message_action", {
      messageIds: ids,
      role: "inbox",
      action: "mark_read",
    })) as { groups: { accountId: string; queued: number; error: string | null }[] };

    expect(groups.map((g) => [g.accountId, g.queued, g.error])).toEqual([
      ["acc_1", 100, null],
      ["acc_2", 100, null],
    ]);
    expect(ids.every((id) => desired(host, id).read === 1 && desired(host, id).seen === 1)).toBe(true);
  });

  it("moves a role batch per account and reports each group's destination or refusal", async () => {
    const host = await load({ seed: (bb) => seedTwoAccounts(bb) });
    const [a1] = idsIn(host, "acc_1", "INBOX");
    const [b1] = idsIn(host, "acc_2", "INBOX");

    await expect(
      host.harness.behavior.callRpc("message_action", { messageIds: [a1, b1], role: "inbox", action: "spam" }),
    ).resolves.toEqual({
      groups: [
        { accountId: "acc_1", folder: "INBOX", queued: 1, destination: "Junk", error: null },
        {
          accountId: "acc_2",
          folder: "INBOX",
          queued: 0,
          destination: null,
          error: "This account has no Spam folder",
        },
      ],
    });
    expect(movePending(host, a1!)).toBe("Junk");
    expect(movePending(host, b1!)).toBeNull();
  });

  it("refuses per group while one account needs its password", async () => {
    const host = await load({
      seed: (bb) => {
        seedTwoAccounts(bb);
        createSqliteStore(bb.storage.database()).recordSyncResult("acc_2", {
          lastSyncAt: null,
          lastError: "Authentication failed",
          authFailed: true,
        });
      },
    });
    const [a1] = idsIn(host, "acc_1", "INBOX");
    const [b1] = idsIn(host, "acc_2", "INBOX");

    const { groups } = (await host.harness.behavior.callRpc("message_action", {
      messageIds: [a1, b1],
      role: "inbox",
      action: "mark_unread",
    })) as { groups: { accountId: string; error: string | null }[] };

    expect(groups.map((g) => [g.accountId, g.error])).toEqual([
      ["acc_1", null],
      ["acc_2", PASSWORD_NEEDED_MESSAGE],
    ]);
    expect(desired(host, a1!).seen).toBe(0);
    expect(desired(host, b1!).seen).toBeNull();
  });

  it("refuses role all for actions and lists", async () => {
    const host = await load({ seed: (bb) => seedTwoAccounts(bb) });
    const [a1] = idsIn(host, "acc_1", "INBOX");

    await expect(
      host.harness.behavior.callRpc("message_action", { messageIds: [a1], role: "all", action: "flag" }),
    ).rejects.toThrow("All Mail is not a merged folder");
    await expect(
      host.harness.behavior.callRpc("threads_list", {
        scope: { kind: "all", role: "all" },
        cursor: null,
        limit: 10,
      }),
    ).rejects.toThrow("All Mail is not a merged folder");
    expect(desired(host, a1!).flagged).toBeNull();
  });

  it("moves to a chosen folder of the same account", async () => {
    const host = await load({ seed: (bb) => seedTwoAccounts(bb) });
    const [a1, a2] = idsIn(host, "acc_1", "INBOX");
    const [b1] = idsIn(host, "acc_2", "INBOX");
    const move = (messageIds: string[], destination: string, folder = "INBOX") =>
      host.harness.behavior.callRpc("message_action", { messageIds, folder, action: "move", destination });

    await expect(move([a1!], "Work")).resolves.toEqual(movedGroup("acc_1", "INBOX", 1, "Work"));
    expect(movePending(host, a1!)).toBe("Work");
    await expect(move([a2!], "Nowhere")).rejects.toThrow("This account has no folder Nowhere");
    await expect(move([a2!], "INBOX")).rejects.toThrow("Already in INBOX");
    // One destination path for two accounts: each group checks its own account.
    await expect(move([a2!, b1!], "Deleted Messages")).resolves.toEqual({
      groups: [
        { accountId: "acc_1", folder: "INBOX", queued: 1, destination: "Trash", error: null },
        {
          accountId: "acc_2",
          folder: "INBOX",
          queued: 0,
          destination: null,
          error: "This account has no folder Deleted Messages",
        },
      ],
    });
    expect(movePending(host, b1!)).toBeNull();
  });

  it("refuses a move into a folder that cannot hold messages", async () => {
    const host = await load({
      seed: (bb) =>
        seedMail(bb, {
          folders: [...ICLOUD_FOLDERS, { path: "Projects", selectable: false }],
          messages: [{ folder: "INBOX", message: makeFetchedMessage(1) }],
        }),
    });
    const id = messageIdAt(host, "INBOX", 1);

    await expect(
      host.harness.behavior.callRpc("message_action", {
        messageIds: [id],
        folder: "INBOX",
        action: "move",
        destination: "Projects",
      }),
    ).rejects.toThrow("Projects cannot hold messages");
    expect(movePending(host, id)).toBeNull();
  });

  it("a flag action wakes sync, which pushes the change to the server", async () => {
    const host = await load();
    const { accountId, messageId } = await addAndSync(host);

    await expect(
      host.harness.behavior.callRpc("message_action", {
        messageIds: [messageId],
        folder: "INBOX",
        action: "flag",
      }),
    ).resolves.toEqual({
      groups: [{ accountId, folder: "INBOX", queued: 1, destination: null, error: null }],
    });
    const service = host.harness.behavior.runService("sync");
    await vi.waitFor(() => expect(host.gateway.mailbox.messages[0]!.flagged).toBe(true));
    service.controller.abort();
    await service.done;
    const calls = host.gateway.sessions.flatMap((s) => s.calls);
    expect(calls).toContainEqual(expect.objectContaining({ method: "setFlags", change: { flagged: true } }));
  });
});

const BOUNDARY = "invented-boundary";

/** A raw message with a text part and, optionally, one attachment. */
function rawMail(
  options: {
    messageId?: string | null;
    subject?: string;
    attachment?: { filename: string; mimeType: string; content: string };
  } = {},
): Uint8Array {
  const lines = [
    "From: Sender <sender@example.org>",
    "To: owner@example.org",
    `Subject: ${options.subject ?? "Invented quarterly note"}`,
    "Date: Fri, 13 Nov 2026 08:30:00 +0000",
  ];
  if (options.messageId !== null) lines.push(`Message-ID: ${options.messageId ?? "<msg-1@example.org>"}`);
  lines.push(
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    "",
    `--${BOUNDARY}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Invented body about the garden fence.",
  );
  if (options.attachment) {
    const { filename, mimeType, content } = options.attachment;
    lines.push(
      `--${BOUNDARY}`,
      `Content-Type: ${mimeType}`,
      `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(content).toString("base64"),
    );
  }
  lines.push(`--${BOUNDARY}--`, "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

/** The stored row for `raw`, with attachment metadata as the gateway records it. */
async function storedFor(raw: Uint8Array, overrides: Partial<FetchedMessage> = {}): Promise<FetchedMessage> {
  const parsed = await parseMail(raw);
  return makeFetchedMessage(1, {
    messageId: parsed.messageId ?? null,
    subject: parsed.subject ?? "",
    date: "2026-11-13T08:30:00.000Z",
    size: raw.byteLength,
    attachments: parsed.attachments.map((a, index) => ({
      partId: String(index + 1),
      filename: a.filename,
      mimeType: a.mimeType,
      size: (a.content as ArrayBuffer).byteLength,
      isInline: false,
    })),
    ...overrides,
  });
}

/** acc_1 with one INBOX message (uid 1) whose raw bytes the server serves. */
async function loadRaw(raw: Uint8Array, overrides: Partial<FetchedMessage> = {}, served: Uint8Array = raw) {
  const message = await storedFor(raw, overrides);
  const vaultKey = generateVaultKey();
  const host = await load({
    settings: { vaultKey },
    seed: (bb) => {
      seedMail(bb, { folders: ICLOUD_FOLDERS, messages: [{ folder: "INBOX", message }] });
      // A password the plugin's vault can open, so the raw fetch can log in.
      bb.storage
        .database()
        .prepare("UPDATE accounts SET password_sealed = ?")
        .run(createVault(vaultKey).seal(PASSWORD));
      createSqliteStore(bb.storage.database()).saveSyncState("acc_1", "INBOX", {
        uidValidity: 3,
        lastUid: 1,
        syncedSince: "2026-10-01T00:00:00.000Z",
      });
    },
    server: (gateway) => gateway.setRaw("INBOX", 1, served),
  });
  return { host, messageId: messageIdAt(host, "INBOX", 1) };
}

type Source = {
  headers: [string, string][];
  structure: string[];
  size: number;
  uid: number;
  folder: string;
  accountEmail: string;
};

/** No session wrote anything: every one was read-only and none stored flags or moved. */
function expectNoWrites(host: Host): void {
  expect(host.gateway.sessions.length).toBeGreaterThan(0);
  for (const session of host.gateway.sessions) {
    expect(session.readOnly).toBe(true);
    expect(session.closed).toBe(true);
    expect(session.calls.map((c) => c.method)).not.toEqual(
      expect.arrayContaining(["setFlags"]),
    );
    for (const call of session.calls) expect(["status", "fetchRaw"]).toContain(call.method);
  }
}

function logText(host: Host): string {
  return JSON.stringify(host.harness.inspection.logEntries);
}

describe("makosh-mail server: source and downloads", () => {
  it("message_source returns headers as text and the MIME structure, never marking read", async () => {
    const raw = rawMail({
      subject: "<script>alert(1)</script>",
      attachment: { filename: "report.pdf", mimeType: "application/pdf", content: "Invented" },
    });
    const { host, messageId } = await loadRaw(raw);

    const source = (await host.harness.behavior.callRpc("message_source", { messageId })) as Source;

    expect(source.headers).toContainEqual(["Subject", "<script>alert(1)</script>"]);
    expect(source.headers[0]).toEqual(["From", "Sender <sender@example.org>"]);
    expect(source.structure[0]).toMatch(/^multipart\/mixed · /);
    expect(source.structure).toContainEqual('  application/pdf · attachment · "report.pdf" · 12 B');
    expect(source).toMatchObject({ size: raw.byteLength, uid: 1, folder: "INBOX", accountEmail: "owner@example.org" });
    expectNoWrites(host);
    expect(desired(host, messageId)).toEqual({ seen: null, flagged: null, read: 0 });
  });

  it("refuses a message renumbered on the server", async () => {
    const { host, messageId } = await loadRaw(rawMail());
    host.gateway.mailbox.uidValidity = 4;

    await expect(host.harness.behavior.callRpc("message_source", { messageId })).rejects.toThrow(STALE_MESSAGE);
    // The uid was not fetched under the new UIDVALIDITY.
    expect(host.gateway.sessions.flatMap((s) => s.calls).map((c) => c.method)).toEqual(["status"]);
  });

  it("refuses detached rows and rows waiting to move without opening a session", async () => {
    const { host, messageId } = await loadRaw(rawMail());
    const store = createSqliteStore(host.bb.storage.database());

    store.queueMove([messageId], "Junk");
    await expect(host.harness.behavior.callRpc("message_source", { messageId })).rejects.toThrow(
      UNAVAILABLE_MESSAGE,
    );
    host.bb.storage.database().prepare("UPDATE messages SET move_pending = NULL").run();
    store.beginFolderReset("acc_1", "INBOX");
    await expect(
      host.harness.behavior.callRpc("download_ticket", { kind: "eml", messageId }),
    ).rejects.toThrow(UNAVAILABLE_MESSAGE);
    expect(host.gateway.sessions).toEqual([]);
  });

  it("refuses when the fetched size or Message-ID differ from the stored ones", async () => {
    const raw = rawMail();
    const sized = await loadRaw(raw, { size: raw.byteLength + 1 });
    await expect(
      sized.host.harness.behavior.callRpc("message_source", { messageId: sized.messageId }),
    ).rejects.toThrow(STALE_MESSAGE);

    const other = await loadRaw(raw, {}, rawMail({ messageId: "<other@example.org>" }));
    await expect(
      other.host.harness.behavior.callRpc("message_source", { messageId: other.messageId }),
    ).rejects.toThrow(STALE_MESSAGE);

    const missing = await loadRaw(raw, {}, rawMail({ messageId: null }));
    await expect(
      missing.host.harness.behavior.callRpc("message_source", { messageId: missing.messageId }),
    ).rejects.toThrow(STALE_MESSAGE);
  });

  it("refuses a stored size over 50 MB before fetching", async () => {
    const { host, messageId } = await loadRaw(rawMail(), { size: 50 * 1024 * 1024 + 1 });

    await expect(host.harness.behavior.callRpc("message_source", { messageId })).rejects.toThrow(
      TOO_LARGE_MESSAGE,
    );
    await expect(
      host.harness.behavior.callRpc("download_ticket", { kind: "eml", messageId }),
    ).rejects.toThrow(TOO_LARGE_MESSAGE);
    expect(host.gateway.sessions).toEqual([]);
  });

  it("downloads the .eml byte for byte once, with the download headers", async () => {
    const raw = rawMail();
    const { host, messageId } = await loadRaw(raw);

    const ticket = (await host.harness.behavior.callRpc("download_ticket", { kind: "eml", messageId })) as {
      url: string;
      fileName: string;
    };
    expect(ticket.fileName).toBe("2026-11-13 Invented quarterly note.eml");
    expect(ticket.url).toMatch(/^\/api\/v1\/plugins\/makosh-mail\/http\/download\?t=[A-Za-z0-9_-]{43}$/);
    const path = ticket.url.replace("/api/v1/plugins/makosh-mail/http", "");

    const response = await host.harness.behavior.fetchHttp("GET", path);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(raw);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => (headers[name] = value));
    expect(headers).toEqual({
      "content-type": "message/rfc822",
      "content-length": String(raw.byteLength),
      "content-disposition": `attachment; filename="2026-11-13 Invented quarterly note.eml"; filename*=UTF-8''2026-11-13%20Invented%20quarterly%20note.eml`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
    });
    expectNoWrites(host);
    expect(desired(host, messageId).read).toBe(0);

    const again = await host.harness.behavior.fetchHttp("GET", path);
    expect(again.status).toBe(404);
    expect(await again.text()).toBe("");
    const route = host.harness.inspection.registrations.httpRoutes.find((r) => r.path === "/download");
    expect(route).toMatchObject({ method: "GET", auth: "local" });
    const logs = logText(host);
    expect(logs).not.toContain(path.split("t=")[1]!);
    expect(logs).not.toContain("garden fence");
    expect(logs).not.toContain("quarterly");
  });

  it("refuses an expired, unknown or missing ticket with a bare 404", async () => {
    const { host, messageId } = await loadRaw(rawMail());
    const { url } = (await host.harness.behavior.callRpc("download_ticket", { kind: "eml", messageId })) as {
      url: string;
    };
    host.clock.set(new Date(NOW.getTime() + TICKET_TTL_MS));

    for (const path of [url.replace("/api/v1/plugins/makosh-mail/http", ""), "/download", "/download?t=abc", `/download?messageId=${messageId}`]) {
      const response = await host.harness.behavior.fetchHttp("GET", path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe("");
    }
    expect(host.gateway.sessions).toEqual([]);
  });

  it("serves an attachment's bytes with a safe type and file name", async () => {
    const raw = rawMail({
      attachment: { filename: "../../evil\u202Elmth.html", mimeType: "text/html", content: "<script>x</script>" },
    });
    const { host, messageId } = await loadRaw(raw);

    const ticket = (await host.harness.behavior.callRpc("download_ticket", {
      kind: "attachment",
      messageId,
      partId: "1",
    })) as { url: string; fileName: string };
    expect(ticket.fileName).toBe("evillmth.html");
    const response = await host.harness.behavior.fetchHttp(
      "GET",
      ticket.url.replace("/api/v1/plugins/makosh-mail/http", ""),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<script>x</script>");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("18");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="evillmth.html"; filename*=UTF-8''evillmth.html`,
    );
    expectNoWrites(host);
    expect(logText(host)).not.toContain("evil");
  });

  it("keeps CR/LF and quotes out of the download headers", async () => {
    const raw = rawMail({
      attachment: { filename: 'a\r\nSet-Cookie: x=1 "q".pdf', mimeType: "application/pdf", content: "Invented" },
    });
    const { host, messageId } = await loadRaw(raw);

    const { url, fileName } = (await host.harness.behavior.callRpc("download_ticket", {
      kind: "attachment",
      messageId,
      partId: "1",
    })) as { url: string; fileName: string };
    const response = await host.harness.behavior.fetchHttp("GET", url.replace("/api/v1/plugins/makosh-mail/http", ""));

    expect(fileName).not.toMatch(/[\r\n]/);
    expect(response.headers.get("set-cookie")).toBeNull();
    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).toMatch(/^attachment; filename="[^"\\]*"; filename\*=UTF-8''[A-Za-z0-9%._!~-]+$/);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("refuses an attachment that changed on the server with 409", async () => {
    const raw = rawMail({ attachment: { filename: "report.pdf", mimeType: "application/pdf", content: "Invented" } });
    const message = await storedFor(raw);
    // Same size, Message-ID and part count; a different file name in the part.
    const served = rawMail({ attachment: { filename: "rep0rt.pdf", mimeType: "application/pdf", content: "Invented" } });
    const { host, messageId } = await loadRaw(raw, { attachments: message.attachments }, served);

    const { url } = (await host.harness.behavior.callRpc("download_ticket", {
      kind: "attachment",
      messageId,
      partId: "1",
    })) as { url: string };
    const response = await host.harness.behavior.fetchHttp("GET", url.replace("/api/v1/plugins/makosh-mail/http", ""));

    expect(response.status).toBe(409);
    expect(await response.text()).toBe(STALE_MESSAGE);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses a ticket for an attachment the message does not have", async () => {
    const { host, messageId } = await loadRaw(rawMail());

    await expect(
      host.harness.behavior.callRpc("download_ticket", { kind: "attachment", messageId, partId: "2" }),
    ).rejects.toThrow("Unknown attachment");
    await expect(
      host.harness.behavior.callRpc("download_ticket", { kind: "eml", messageId: "missing" }),
    ).rejects.toThrow("Unknown message");
  });

  it("a long attachment name is cut to 120 characters keeping the extension", async () => {
    const raw = rawMail({
      attachment: { filename: `${"n".repeat(300)}.pdf`, mimeType: "application/pdf", content: "Invented" },
    });
    const { host, messageId } = await loadRaw(raw);

    const { fileName } = (await host.harness.behavior.callRpc("download_ticket", {
      kind: "attachment",
      messageId,
      partId: "1",
    })) as { fileName: string };
    expect(fileName).toBe(`${"n".repeat(116)}.pdf`);
  });
});

function downloadPath(url: string): string {
  return url.replace("/api/v1/plugins/makosh-mail/http", "");
}

describe("makosh-mail server: fix round 1", () => {
  it("serves one of two concurrent redemptions of a ticket and fetches once", async () => {
    const { host, messageId } = await loadRaw(rawMail());
    const { url } = (await host.harness.behavior.callRpc("download_ticket", { kind: "eml", messageId })) as {
      url: string;
    };

    const responses = await Promise.all([
      host.harness.behavior.fetchHttp("GET", downloadPath(url)),
      host.harness.behavior.fetchHttp("GET", downloadPath(url)),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(host.gateway.sessions.flatMap((s) => s.calls).filter((c) => c.method === "fetchRaw")).toHaveLength(1);
  });

  it("refuses with 409 when the message changes between minting and redeeming", async () => {
    const attachment = { filename: "report.pdf", mimeType: "application/pdf", content: "Invented" };
    const changes: [string, (host: Host, messageId: string) => void][] = [
      ["uidValidity", (host) => (host.gateway.mailbox.uidValidity = 4)],
      [
        "pending move",
        (host, messageId) => createSqliteStore(host.bb.storage.database()).queueMove([messageId], "Junk"),
      ],
      [
        "size",
        (host) => host.bb.storage.database().prepare("UPDATE messages SET size = size + 1").run(),
      ],
      [
        "Message-ID",
        (host) => host.gateway.setRaw("INBOX", 1, rawMail({ messageId: "<msg-2@example.org>", attachment })),
      ],
      [
        "part MIME type",
        (host) =>
          host.bb.storage.database().prepare("UPDATE attachments SET mime_type = 'application/zip'").run(),
      ],
    ];
    for (const [what, change] of changes) {
      const { host, messageId } = await loadRaw(rawMail({ attachment }));
      const { url } = (await host.harness.behavior.callRpc("download_ticket", {
        kind: "attachment",
        messageId,
        partId: "1",
      })) as { url: string };
      change(host, messageId);
      const response = await host.harness.behavior.fetchHttp("GET", downloadPath(url));
      expect(response.status, what).toBe(409);
      expect(await response.text(), what).toMatch(/sync and try again$/);
    }
  });

  it("names the download from the stored message when the ticket is redeemed", async () => {
    const { host, messageId } = await loadRaw(rawMail());
    const { url } = (await host.harness.behavior.callRpc("download_ticket", { kind: "eml", messageId })) as {
      url: string;
    };
    host.bb.storage.database().prepare("UPDATE messages SET subject = 'Renamed note'").run();

    const response = await host.harness.behavior.fetchHttp("GET", downloadPath(url));
    expect(response.headers.get("content-disposition")).toContain('filename="2026-11-13 Renamed note.eml"');
  });

  it("degrades instead of failing when headers are huge", async () => {
    const word = `=?UTF-8?B?${Buffer.from("a".repeat(225_000)).toString("base64")}?=`;
    const { host, messageId } = await loadRaw(rawMail({ subject: `${word} ${word}` }));

    const source = (await host.harness.behavior.callRpc("message_source", { messageId })) as Source;
    expect(source.headers.at(-1)).toEqual(["…", "truncated"]);
  });

  it("applies nothing of a group with a refused id, and counts only stored ids", async () => {
    const host = await load({ seed: (bb) => seedTwoAccounts(bb) });
    const [a1, a2] = idsIn(host, "acc_1", "INBOX");
    const [b1] = idsIn(host, "acc_2", "INBOX");
    createSqliteStore(host.bb.storage.database()).queueMove([a2!], "Work");

    const { groups } = (await host.harness.behavior.callRpc("message_action", {
      messageIds: [a1, a2, b1, "missing"],
      role: "inbox",
      action: "delete",
    })) as { groups: { accountId: string; queued: number; error: string | null }[] };

    expect(groups.map((g) => [g.accountId, g.queued, g.error])).toEqual([
      ["acc_1", 0, "These messages are not all in INBOX"],
      ["acc_2", 1, null],
    ]);
    expect(movePending(host, a1!)).toBeNull();
    expect(movePending(host, b1!)).toBe("Trash");

    const flagged = (await host.harness.behavior.callRpc("message_action", {
      messageIds: [a1, "missing"],
      folder: "INBOX",
      action: "flag",
    })) as { groups: { queued: number }[] };
    expect(flagged.groups[0]!.queued).toBe(1);
  });
});

describe("makosh-mail server: fix round 2", () => {
  it("renderSource marks a part that failed to render and logs the error kind only", () => {
    const lines: string[] = [];
    const raw = new TextEncoder().encode("Subject: Invented secret subject\r\n\r\nInvented body");
    const hostile = () => {
      throw new TypeError("Invented secret subject");
    };

    const both = renderSource(raw, (line) => lines.push(line), {
      readHeaders: hostile,
      describeStructure: hostile,
    });

    expect(both).toEqual({
      headers: [["…", "headers unavailable"]],
      structure: ["structure unavailable"],
    });
    expect(lines).toEqual([
      "message source: headers could not be rendered (TypeError)",
      "message source: structure could not be rendered (TypeError)",
    ]);
    expect(lines.join("\n")).not.toContain("Invented");
    expect(renderSource(raw, (line) => lines.push(line)).headers).toEqual([
      ["Subject", "Invented secret subject"],
    ]);
  });
});
