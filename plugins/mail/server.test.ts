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
import type { MessageSummary, ThreadDetail } from "./src/core/index.ts";
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
};

async function load(options: LoadOptions = {}) {
  const gateway = new ScriptedImapGateway({ uidValidity: 3, uidNext: 1, messages: [] });
  gateway.deliver({
    subject: "Invented quarterly note",
    bodyText: "Invented body about the garden fence.",
    date: "2026-11-13T08:30:00.000Z",
  });
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
      await host.harness.behavior.callRpc("threads_list", { accountId, cursor: null, limit: 50 }),
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
    expect(items[0]!.subtitle).toBe("Sender <sender@example.org> · 2026-11-13 08:30");
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
});
