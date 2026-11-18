// Remote Hub — BB backend entry.
//
// Composition root: builds the BB adapter (HelperProcess) and the host-free
// service, exposes a schema-validated RPC contract to the app, and tears the
// helper down on dispose. All wire schemas live in src/core/rpc.ts and
// src/core/protocol.ts.
import { agentExecPorts } from "./src/adapters/bb/agent-exec.ts";
import { createExecTools } from "./src/core/agent-exec-tools.ts";
import { AgentSettings } from "./src/core/agent-settings.ts";
import { publishAgentSignals } from "./src/adapters/bb/agent-signals.ts";
import { AgentFeed } from "./src/core/agent-feed.ts";
import { WatcherBook } from "./src/core/watchers.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { HELPER_BIN_NAME, HelperProcess } from "./src/adapters/bb/helper-process.ts";
import { ALL_MIGRATIONS } from "./src/adapters/bb/migrations.ts";
import { AgentAccessBook } from "./src/core/agent-access.ts";
import { AgentAudit } from "./src/core/agent-audit.ts";
import { ToolBudget } from "./src/core/agent-budget.ts";
import { AgentSessionRegistry, controlSessionExtras, createControlTools } from "./src/core/agent-control-tools.ts";
import { ControlLeases } from "./src/core/control-lease.ts";
import { createAgentTools } from "./src/core/agent-tools.ts";
import { agentControlPorts, createControlGate, registerControlLifecycle } from "./src/adapters/bb/agent-control.ts";
import { createAgentControlRpc } from "./src/adapters/bb/agent-control-rpc.ts";
import { agentPorts, registerAgentTools } from "./src/adapters/bb/agent-tools.ts";
import { createSqliteAgentAuditStore, createSqliteAgentGrantStore, createSqliteAgentSettingsStore } from "./src/adapters/bb/agent-sqlite.ts";
import { createRdpTrustStore } from "./src/core/rdp-trust.ts";
import { createSqliteRdpTrust } from "./src/adapters/bb/rdp-trust-sqlite.ts";
import { createSqliteProfileStore } from "./src/adapters/bb/profile-sqlite.ts";
import { createRemoteHubService } from "./src/adapters/bb/service.ts";
import { registerStreamSocket } from "./src/adapters/bb/stream-socket.ts";
import { createSqliteCredentialStore } from "./src/adapters/bb/credential-sqlite.ts";
import { createFsSourceReader } from "./src/adapters/bb/fs-source-reader.ts";
import { createSqliteImportStore } from "./src/adapters/bb/import-sqlite.ts";
import { createRpcHandlers } from "./src/adapters/bb/rpc-handlers.ts";
import { createPveRpc } from "./src/adapters/bb/pve-rpc.ts";
import { createSqlitePveGuestLinks } from "./src/adapters/bb/pve-sqlite.ts";
import { ImportBook } from "./src/core/import-book.ts";
import { CredentialBook } from "./src/core/credential.ts";
import { ProfileBook } from "./src/core/profile-book.ts";
import { rpcSchemas } from "./src/core/rpc.ts";

export const rpcContract = defineRpcContract(rpcSchemas);

/**
 * The plugin root: server.ts lives there in a checkout and is compiled to
 * dist/ by bb plugin build, so try the current directory and its parent.
 */
function pluginRootDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [here, dirname(here)];
  for (const dir of candidates) {
    if (existsSync(join(dir, "bin", HELPER_BIN_NAME))) return dir;
  }
  return here;
}

export default function plugin(bb: BbPluginApi): void {
  const db = bb.storage.database();
  bb.storage.migrate(db, ALL_MIGRATIONS);
  // Who drives which session (stage 4b-1): in memory only, so a restart gives every session back to the human.
  const leases = new ControlLeases({ now: () => Date.now(), newId: () => randomUUID() });
  const watchers = new WatcherBook({ now: () => Date.now() });
  const agentSettings = new AgentSettings(createSqliteAgentSettingsStore(db));
  const feed = new AgentFeed();
  const service = createRemoteHubService({
    control: createControlGate(leases, watchers, agentSettings),
    startHelper: () => HelperProcess.start(pluginRootDir()),
    trust: createRdpTrustStore(createSqliteRdpTrust(db)),
  });
  const profiles = new ProfileBook({
    store: createSqliteProfileStore(db),
    now: () => new Date(),
    newId: () => randomUUID(),
    onHistoryError: (code) => bb.log.warn(`profile history not written (${code})`),
  });
  const importStore = createSqliteImportStore(db);
  const credentials = new CredentialBook({
    store: createSqliteCredentialStore(db),
    vault: service.credentialVault,
    profiles,
    now: () => new Date(),
    newId: () => randomUUID(),
  });
  const imports = new ImportBook({ store: importStore, reader: createFsSourceReader(), profiles, credentials, newId: () => randomUUID(), knownHosts: service.knownHosts });
  // Agent access (stage 4a): grants the owner sets on the page, an audit of every tool call, and the read-only tools.
  const agentAccess = new AgentAccessBook({ store: createSqliteAgentGrantStore(db), profiles: { has: (id) => profiles.get(id) !== null }, now: () => new Date() });
  const agentAudit = new AgentAudit({ store: createSqliteAgentAuditStore(db), now: () => new Date() });
  const registry = new AgentSessionRegistry();
  const pveRpc = createPveRpc({ service, profiles, credentials, links: createSqlitePveGuestLinks(db), newId: () => randomUUID(), now: () => new Date(), audit: agentAudit });
  const handlers = createRpcHandlers({
    service,
    profiles,
    credentials,
    imports,
    pve: pveRpc,
    agents: { access: agentAccess, audit: agentAudit },
    agentControl: createAgentControlRpc({ service, leases, registry, audit: agentAudit, watchers, settings: agentSettings }),
    openedBy: (key) => registry.threadOf(key),
  });
  const controlPorts = agentControlPorts({ service, profiles, handlers, watchers, settings: agentSettings });
  const toolDeps = {
    access: agentAccess,
    audit: agentAudit,
    budget: new ToolBudget({ now: () => Date.now() }),
    ports: agentPorts(service, profiles),
    sessionExtras: controlSessionExtras(leases, controlPorts),
  };
  const controlDeps = { ...toolDeps, leases, control: controlPorts, registry, feed };
  const execPorts = agentExecPorts({ service, profiles, credentials, feed });
  registerAgentTools(bb, [...createAgentTools(toolDeps), ...createControlTools(controlDeps), ...createExecTools({ ...controlDeps, exec: execPorts })]);
  bb.rpc.register(rpcContract, handlers);
  registerControlLifecycle(bb, { leases, registry, service, watchers, closeSession: (key) => controlPorts.disconnect(key) });

  publishAgentSignals(bb, { leases, watchers, registry });
  registerStreamSocket(bb, { service, audit: agentAudit, watchers, feed });

  bb.onDispose(() => {
    service.stop();
  });
}
