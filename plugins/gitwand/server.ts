// Makosh GitWand — BB backend entry.
//
// Composition root: the GitWand runtime (gitwand-bridge + UI) from the plugin's
// data directory or a development directory, the bridge as a stdio child
// process, the relay the GitWand page talks to (POST /gw/invoke, WS /gw/ws),
// one GET route per UI file, the signed update channel, and the RPC the BB
// page uses for the thread tab and the settings section.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, relative, sep } from "node:path";
import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi, type ExperimentalPluginWebSocket } from "@get-bb/plugin-sdk";
import { experimental_hostToolchain, experimental_spawnHostProcess } from "@get-bb/plugin-sdk/process";
import { BridgeSupervisor, bridgeEnv, type SpawnBridge } from "./src/adapters/bb/bridge-process.ts";
import { GitwandRelay } from "./src/adapters/bb/relay.ts";
import { smokeRuntime } from "./src/adapters/bb/runtime-smoke.ts";
import { RuntimeStore, resolveRuntime, type InstalledRuntime } from "./src/adapters/bb/runtime-store.ts";
import { shimScript } from "./src/adapters/bb/shim-script.ts";
import { repoForThread, type ThreadSdk } from "./src/adapters/bb/thread-repo.ts";
import { EMBED_CSS, UiRoutes } from "./src/adapters/bb/ui-http.ts";
import { UpdateService, type UpdateCheck } from "./src/adapters/bb/update-service.ts";
import { rpcSchemas, type GitWandStatus } from "./src/core/contract.ts";
import { PLUGIN_HTTP_BASE } from "./src/core/frame-url.ts";
import { platformKey } from "./src/core/versions.ts";
import packageJson from "./package.json" with { type: "json" };

export const rpcContract = defineRpcContract(rpcSchemas);

const spawnBridge: SpawnBridge = (bin, args, options) => experimental_spawnHostProcess(bin, args, { env: options.env });

async function uiFiles(uiDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(uiDir, path).split(sep).join("/"));
    }
  };
  await walk(uiDir);
  return out;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    runtimeDir: {
      type: "string",
      label: "Development runtime directory",
      description:
        "An unpacked runtime built by scripts/build-runtime.ts (…/.runtime/<version>-<platform>). Used instead of the installed runtime while set. GITWAND_RUNTIME_DIR in the BB server's environment does the same.",
      default: "",
    },
    updateChannelUrl: {
      type: "string",
      label: "Update channel URL",
      description: "https URL of channel.json; channel.json.minisig must sit next to it. Updates are off while empty.",
      default: "",
    },
    updatePublicKey: {
      type: "string",
      label: "Update signing key",
      description: "The minisign public key (both lines) that signs channel.json. Updates are off while empty.",
      default: "",
    },
  });

  const platform = platformKey(process.platform, process.arch);
  const env = () => bridgeEnv(experimental_hostToolchain.environment(process.env), userInfo().shell || "/bin/zsh");
  const store =
    platform === null
      ? null
      : new RuntimeStore({
          root: join(bb.server.experimental_dataDir, "runtime"),
          platform,
          smoke: (candidate) => smokeRuntime(candidate, { spawn: spawnBridge, env: env() }),
        });

  // The runtime in use, verified once and refreshed after installs and rollbacks.
  let runtime: (InstalledRuntime & { source: "dev" | "installed" }) | null = null;
  let runtimeError: string | null = platform === null ? `GitWand is not built for ${process.platform}-${process.arch}` : null;
  async function refreshRuntime(): Promise<void> {
    if (store === null) return;
    try {
      const devDir = (await settings.get()).runtimeDir.trim() || process.env.GITWAND_RUNTIME_DIR || null;
      runtime = await resolveRuntime({ devDir, store });
      runtimeError = null;
    } catch (error) {
      runtime = null;
      runtimeError = (error as Error).message;
      bb.log.warn(`GitWand runtime unusable: ${runtimeError}`);
    }
  }

  const supervisor = new BridgeSupervisor({
    resolve: async () => (runtime === null ? null : { bin: runtime.bin, env: env() }),
    spawn: spawnBridge,
    onInvalidLine: (line) => bb.log.warn(`gitwand-bridge wrote an unexpected line: ${line.slice(0, 200)}`),
  });
  const relay = new GitwandRelay({ get: () => supervisor.get(), current: () => supervisor.running() });
  supervisor.onChannel((channel, message) => relay.onBridgeChannel(channel, message));
  supervisor.onLost((reason) => {
    bb.log.info(`gitwand-bridge stopped: ${reason}`);
    relay.onBridgeLost(reason);
  });
  bb.onDispose(() => supervisor.stop());

  // UI files: one route per file of the runtime in use.
  const routes = new UiRoutes(
    (route, handler) => bb.http.route("GET", route, handler),
    async () => runtime?.uiDir ?? null,
  );
  // BB may refuse routes registered after load; then the new UI files need a plugin reload.
  let routesNotice: string | null = null;
  async function ensureUiRoutes(): Promise<void> {
    const { failed } = routes.ensure(runtime === null ? ["index.html"] : await uiFiles(runtime.uiDir));
    routesNotice =
      failed.length === 0
        ? null
        : `Новый интерфейс GitWand заработает после перезагрузки плагина (${failed.length} новых файлов): bb plugin reload makosh-gitwand или выключите и включите плагин.`;
    if (failed.length > 0) bb.log.warn(`could not register ${failed.length} UI routes after load`);
  }
  await refreshRuntime();
  await ensureUiRoutes();

  const shim = shimScript(`${PLUGIN_HTTP_BASE}/gw/`);
  bb.http.route("GET", "/gw/shim.js", () => new Response(shim, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } }));
  bb.http.route("GET", "/gw/embed.css", () => new Response(EMBED_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } }));
  bb.http.route("POST", "/gw/invoke", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json({ error: "Malformed GitWand call" }, { status: 400 });
    }
    const r = await relay.invoke(body);
    return Response.json(r.body, { status: r.status });
  });
  bb.http.experimental_websocket("/gw/ws", () => {
    let conn: string | null = null;
    return {
      onOpen(socket: ExperimentalPluginWebSocket) {
        conn = relay.open(socket);
      },
      async onClose() {
        if (conn !== null) await relay.close(conn);
      },
    };
  });

  // Updates: off until a channel URL and a signing key are set.
  let lastCheck: UpdateCheck | null = null;
  const updates = async () => {
    const s = await settings.get();
    return new UpdateService({
      channelUrl: s.updateChannelUrl,
      publicKey: s.updatePublicKey,
      platform: platform ?? "darwin-arm64",
      pluginVersion: packageJson.version,
      installed: async () => (runtime?.source === "installed" ? runtime.version : null),
    });
  };
  let service: UpdateService | null = null;
  async function checkUpdates(): Promise<UpdateCheck> {
    service = await updates();
    lastCheck = platform === null ? { kind: "error", error: runtimeError ?? "unsupported platform" } : await service.check();
    return lastCheck;
  }
  bb.background.schedule("check-updates", "17 */6 * * *", async () => {
    await checkUpdates();
  });
  bb.http.route("GET", "/gw/update", () => {
    const p = service?.pending() ?? null;
    return Response.json({ update: p === null ? null : { version: p.version, currentVersion: p.currentVersion ?? runtime?.version ?? null, date: null, body: null } });
  });
  /** Installs the pending build; the running bridge stops so the next call starts the new one. */
  async function installPending(version: string | undefined): Promise<{ ok: true } | { status: number; error: string }> {
    const p = service?.pending() ?? null;
    if (store === null || p === null || p.version !== version) return { status: 409, error: "No GitWand update is pending" };
    try {
      await store.install(p);
    } catch (error) {
      return { status: 500, error: (error as Error).message };
    }
    await refreshRuntime();
    await ensureUiRoutes();
    await supervisor.stop();
    await checkUpdates();
    return { ok: true };
  }
  bb.http.route("POST", "/gw/update/install", async (c) => {
    const { version } = (await c.req.json().catch(() => ({}))) as { version?: string };
    const r = await installPending(version);
    return "ok" in r ? Response.json({ ok: { version } }) : Response.json({ error: r.error }, { status: r.status });
  });

  async function status(): Promise<GitWandStatus> {
    const s = supervisor.status();
    const updateState: GitWandStatus["update"] =
      lastCheck === null
        ? { state: "unchecked", detail: null }
        : lastCheck.kind === "available"
          ? { state: "available", detail: lastCheck.version }
          : lastCheck.kind === "needs-plugin"
            ? { state: "needs-plugin", detail: lastCheck.minPluginVersion }
            : lastCheck.kind === "error"
              ? { state: "error", detail: lastCheck.error }
              : { state: lastCheck.kind, detail: null };
    const has = (tool: string) => experimental_hostToolchain.resolve(tool) !== null;
    return {
      platform,
      runtime: runtime === null ? null : { version: runtime.version, source: runtime.source, commit: runtime.commit },
      runtimeError,
      bridge: { state: runtime === null && s.state !== "failed" ? "no-runtime" : s.state, detail: s.state === "failed" ? s.error : null },
      tools: { git: has("git"), gh: has("gh"), glab: has("glab") },
      update: updateState,
      notice: routesNotice,
    };
  }

  const refuse = (error: unknown): never => {
    throw new experimental_PluginRpcRefusal({ code: "invalid", message: error instanceof Error ? error.message : String(error) });
  };
  type Handlers = Parameters<typeof bb.rpc.register<typeof rpcContract>>[1];
  const handlers: Handlers = {
    status: () => status(),
    restart: async () => {
      await refreshRuntime();
      await ensureUiRoutes();
      await supervisor.restart().catch(refuse);
      return status();
    },
    rollback: async () => {
      if (store === null) refuse(new Error(runtimeError ?? "unsupported platform"));
      await store!.rollback().catch(refuse);
      await refreshRuntime();
      await ensureUiRoutes();
      await supervisor.stop();
      return status();
    },
    check_updates: async () => {
      await checkUpdates();
      return status();
    },
    install_update: async ({ version }) => {
      const r = await installPending(version);
      if (!("ok" in r)) refuse(new Error(r.error));
      return status();
    },
    repo_for_thread: ({ threadId }) => repoForThread(bb.sdk as unknown as ThreadSdk, threadId, existsSync),
  };
  function ownerOnly<K extends keyof Handlers>(key: K): Handlers[K] {
    const run = handlers[key] as (input: unknown) => unknown;
    return ((input: unknown, ctx: { experimental_caller: { kind: string } }) => {
      if (ctx?.experimental_caller?.kind !== "client") {
        throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Действие доступно только в интерфейсе BB" });
      }
      return run(input);
    }) as Handlers[K];
  }
  bb.rpc.register(rpcContract, Object.fromEntries((Object.keys(handlers) as (keyof Handlers)[]).map((key) => [key, ownerOnly(key)])) as Handlers);
}
