// Remote Hub — BB backend entry.
//
// Composition root: builds the BB adapter (HelperProcess) and the host-free
// service, exposes a schema-validated RPC contract to the app, and tears the
// helper down on dispose. All wire schemas live in src/core/rpc.ts and
// src/core/protocol.ts.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { HELPER_BIN_NAME, HelperProcess } from "./src/adapters/bb/helper-process.ts";
import { ALL_MIGRATIONS } from "./src/adapters/bb/migrations.ts";
import { createRdpTrustStore } from "./src/core/rdp-trust.ts";
import { createSqliteRdpTrust } from "./src/adapters/bb/rdp-trust-sqlite.ts";
import { createSqliteProfileStore } from "./src/adapters/bb/profile-sqlite.ts";
import { createRemoteHubService } from "./src/adapters/bb/service.ts";
import { registerStreamSocket } from "./src/adapters/bb/stream-socket.ts";
import { createSqliteCredentialStore } from "./src/adapters/bb/credential-sqlite.ts";
import { createFsSourceReader } from "./src/adapters/bb/fs-source-reader.ts";
import { createSqliteImportStore } from "./src/adapters/bb/import-sqlite.ts";
import { createRpcHandlers } from "./src/adapters/bb/rpc-handlers.ts";
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
  const service = createRemoteHubService({
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
  bb.rpc.register(rpcContract, createRpcHandlers({ service, profiles, credentials, imports }));

  registerStreamSocket(bb, { service });

  bb.onDispose(() => {
    service.stop();
  });
}
