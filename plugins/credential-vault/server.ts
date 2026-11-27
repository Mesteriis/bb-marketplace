import {
  defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi,
  type ExperimentalPluginRpcHandlerContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { callerNamespace } from "./src/core/access";
import { readKey } from "./src/adapters/bb/keychain";
import { migrations, openVault, vaultMetadata } from "./src/adapters/bb/vault";

import { importSelection, importTarget } from "./src/core/import-contract";
import { createPasswordImport } from "./src/adapters/bb/import-password";

const ref = z.string().min(1).max(200);
const secret = z.string().min(1).max(131072);
const state = z.enum(["starting", "ready", "missing", "approval", "no_keychain", "locked", "unavailable"]);
const status = z.object({ state });
export const rpcContract = defineRpcContract({
  experimental_put: { input: z.object({ ref, secret }), output: z.object({ stored: z.literal(true) }) },
  experimental_put_if_absent: { input: z.object({ ref, secret }), output: z.object({ stored: z.boolean() }) },
  experimental_get: { input: z.object({ ref }), output: z.object({ secret: secret.nullable() }) },
  experimental_remove: { input: z.object({ ref }), output: z.object({ removed: z.boolean() }) },
  vault_import_targets: { input: z.null(), output: z.array(importTarget) },
  vault_import_password: { input: importSelection, output: z.object({ imported: z.literal(true) }) },
  vault_status: { input: z.null(), output: status },
  vault_unlock: { input: z.null(), output: status },
});

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const shutdown = new AbortController();
  let masterKey: Buffer | undefined;
  let vault: ReturnType<typeof openVault> | undefined;
  let pending: Promise<void> | undefined;
  let current: z.infer<typeof state> = "starting";

  async function unlock(interactive: boolean) {
    const installed = await bb.sdk.plugins.list({ signal: shutdown.signal });
    const root = installed.plugins.find((entry) => entry.id === bb.pluginId)?.rootDir;
    if (!root) throw new Error("Credential Vault installation directory unavailable");
    const { account, seal } = vaultMetadata(db);
    let result = await readKey(root, account, "read", shutdown.signal);
    if ("state" in result && result.state === "missing" && seal === null) {
      result = await readKey(root, account, "create", shutdown.signal);
    }
    if ("state" in result && result.state === "approval" && interactive) {
      result = await readKey(root, account, "approve", shutdown.signal);
    }
    if ("state" in result) {
      current = result.state;
      if (result.detail) bb.log.warn(`Credential Vault ${result.detail}`);
      return;
    }
    try {
      if (shutdown.signal.aborted) return;
      vault = openVault(db, result.key);
      masterKey = result.key;
      current = "ready";
    } finally {
      if (masterKey !== result.key) result.key.fill(0);
    }
  }

  function start(interactive: boolean) {
    if (vault || shutdown.signal.aborted) return Promise.resolve();
    return pending ??= unlock(interactive)
      .catch(() => {
        current = "unavailable";
        bb.log.warn("Credential Vault initialization failed");
      })
      .finally(() => { pending = undefined; });
  }

  bb.background.service("unlock", {
    async start(signal) {
      await start(true);
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    },
  });

  bb.onDispose(() => {
    shutdown.abort();
    vault = undefined;
    masterKey?.fill(0);
    masterKey = undefined;
  });

  function namespace(ctx: ExperimentalPluginRpcHandlerContext) {
    try {
      return callerNamespace(ctx.experimental_caller);
    } catch {
      throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Plugin backend required" });
    }
  }

  async function ready(ctx: ExperimentalPluginRpcHandlerContext) {
    await pending;
    ctx.experimental_signal.throwIfAborted();
    if (!vault) throw new experimental_PluginRpcRefusal({ code: "conflict", message: `Credential Vault: ${current}` });
    return vault;
  }

  function requireClient(ctx: ExperimentalPluginRpcHandlerContext) {
    if (ctx.experimental_caller.kind !== "client") {
      throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Open Credential Vault in BB" });
    }
  }

  bb.rpc.register(rpcContract, {
    async experimental_put(input, ctx) {
      const pluginId = namespace(ctx);
      const store = await ready(ctx);
      store.put(pluginId, input.ref, input.secret);
      return { stored: true as const };
    },
    async experimental_put_if_absent(input, ctx) {
      const pluginId = namespace(ctx);
      return { stored: (await ready(ctx)).putIfAbsent(pluginId, input.ref, input.secret) };
    },
    async experimental_get(input, ctx) {
      const pluginId = namespace(ctx);
      return { secret: (await ready(ctx)).get(pluginId, input.ref) };
    },
    async experimental_remove(input, ctx) {
      const pluginId = namespace(ctx);
      return { removed: (await ready(ctx)).remove(pluginId, input.ref) };
    },
    async vault_import_targets(_input, ctx) {
      requireClient(ctx);
      return createPasswordImport(bb.sdk.plugins).targets(ctx.experimental_signal);
    },
    async vault_import_password(input, ctx) {
      requireClient(ctx);
      await ready(ctx);
      return createPasswordImport(bb.sdk.plugins).importPassword(input, ctx.experimental_signal);
    },
    vault_status: () => ({ state: current }),
    async vault_unlock(_input, ctx) {
      requireClient(ctx);
      await start(true);
      return { state: current };
    },
  }, { experimental_discoverable: false });
}
