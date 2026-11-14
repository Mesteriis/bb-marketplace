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
  REMOVE_IN_THREAD_MESSAGE,
} from "./server.ts";
import { MIGRATIONS, createSqliteStore } from "./src/adapters/bb/sqlite-store.ts";
import { generateVaultKey } from "./src/adapters/bb/vault.ts";
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
  makeFetchedMessage,
  makeStoredAccount,
} from "./src/core/testing/fakes.ts";

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
  server?: (gateway: ScriptedImapGateway) => void;
};

async function load(options: LoadOptions = {}) {
  const gateway = new ScriptedImapGateway({ uidValidity: 3, uidNext: 1, messages: [] });
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
  await createMailPlugin({ gateway, clock: new FixedClock(NOW) })(bb);
  return { ...host, gateway };
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

/** Stores account acc_1 with folders and messages before the plugin loads. */
function seedMail(
  bb: BbPluginApi,
  seed: {
    preset?: AccountPreset;
    folders: SeedFolder[];
    messages: { folder: string; message: FetchedMessage }[];
  },
): void {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createSqliteStore(db);
  store.saveAccount(makeStoredAccount({ preset: seed.preset ?? "other" }));
  store.saveFolders(
    "acc_1",
    seed.folders.map((f) => ({
      path: f.path,
      name: f.name ?? f.path.split("/").pop()!,
      delimiter: "/",
      specialUse: f.specialUse ?? null,
      selectable: f.selectable ?? true,
    })),
  );
  for (const { folder, message } of seed.messages) store.upsertMessages("acc_1", folder, [message]);
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
              if (sql.includes("SELECT seq, snippet FROM messages")) throw new Error("disk I/O error");
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

async function listThreads(host: Host, folder: string, accountId = "acc_1"): Promise<ThreadSummary[]> {
  const { threads } = (await host.harness.behavior.callRpc("threads_list", {
    accountId,
    folder,
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
        accountId,
        folder: "INBOX",
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

    expect(host.harness.inspection.logEntries.map((e) => e.message)).toContain(
      "snippet repair failed",
    );
    expect(host.harness.inspection.registrations.rpcMethods).toContain("message_action");
    await expect(host.harness.behavior.callRpc("status_get", null)).resolves.toMatchObject({
      vaultReady: true,
    });
  });

  it("folders_list returns the account's folders in system order", async () => {
    const host = await load({ seed: (bb) => seedMail(bb, { folders: ICLOUD_FOLDERS, messages: [] }) });

    const { folders } = (await host.harness.behavior.callRpc("folders_list", {
      accountId: "acc_1",
    })) as { folders: Folder[] };

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
    ).resolves.toEqual({ queued: 1, destination: "Junk" });

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

    await expect(action(host, [id], "Work", "delete")).resolves.toEqual({
      queued: 1,
      destination: "Trash",
    });
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

    await expect(action(host, [inbox], "INBOX", "archive")).resolves.toEqual({
      queued: 1,
      destination: "All Mail",
    });
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
    await expect(action(host, [junk], "Junk", "not_spam")).resolves.toEqual({
      queued: 1,
      destination: "INBOX",
    });
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
    await expect(action(host, [one], "INBOX", "delete")).resolves.toMatchObject({ queued: 1 });
    await expect(action(host, [one, two], "INBOX", "delete")).rejects.toThrow(
      "These messages are not all in INBOX",
    );
    expect(movePending(host, two)).toBeNull();
    await expect(action(host, [work], "Work", "archive")).resolves.toEqual({
      queued: 1,
      destination: "Archive",
    });
    await expect(action(host, [two], "INBOX", "spam")).resolves.toEqual({
      queued: 1,
      destination: "Junk",
    });
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

  it("actions are not exposed as tools or CLI", async () => {
    const host = await load({ settings: { vaultKey: generateVaultKey(), agentTools: true } });
    const { registrations } = host.harness.inspection;

    expect(registrations.rpcMethods).toEqual(
      expect.arrayContaining(["message_action", "images_allow_sender", "images_disallow_sender"]),
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
