import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { BridgeCli } from "./src/adapters/bb/bridge-cli";
import { bbEnv, resolveBb } from "./src/adapters/bb/bb-binary";
import { CollectionGit } from "./src/adapters/bb/collection-git";
import { CollectionWrite } from "./src/adapters/bb/collection-write";
import { EnvFiles } from "./src/adapters/bb/env-files";
import { checkLaunchers } from "./src/adapters/bb/launchers";
import { PackagesDir } from "./src/adapters/bb/packages-dir";
import { RegistryHttp } from "./src/adapters/bb/registry-http";
import { KvReviewStore } from "./src/adapters/bb/review-store";
import { ReviewThreads } from "./src/adapters/bb/review-threads";
import { unconfiguredCollection, unconfiguredThreads, unconfiguredWrite } from "./src/adapters/bb/unconfigured";
import { rpcSchemas } from "./src/core/contract";
import { createService } from "./src/core/service";
import { missingSettings, settingMissingError } from "./src/core/settings";

export const rpcContract = defineRpcContract(rpcSchemas);

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    marketplaceRepoPath: {
      type: "string",
      label: "Рабочая копия репозитория маркетплейса",
      description: "Откуда читается коллекция проверенных серверов и куда принимаются проверки. Допустим «~».",
      default: "",
    },
    marketplaceProjectId: {
      type: "project",
      label: "Проект маркетплейса в BB",
      description: "В этом проекте запускаются треды проверки серверов.",
      default: "",
    },
  });

  // Built per call: the loopback URL is readable only after the server listens, and settings may change.
  async function service() {
    const { marketplaceRepoPath, marketplaceProjectId } = await settings.get();
    const dataDir = join(bb.server.experimental_dataDir, "plugins", bb.pluginId);
    const repoSetting = marketplaceRepoPath.trim();
    const projectSetting = marketplaceProjectId.trim();
    const repo = repoSetting === "" ? null : expandHome(repoSetting);
    const noRepo = () => settingMissingError(bb.pluginId, "marketplaceRepoPath");
    const noProject = () => settingMissingError(bb.pluginId, "marketplaceProjectId");
    const bbPath = resolveBb(process.env, homedir());
    const env = bbEnv(process.env, { url: bb.server.loopbackBaseUrl, dataDir: bb.server.experimental_dataDir });
    return createService({
      bridge: new BridgeCli(bbPath, env),
      secrets: new EnvFiles(dataDir),
      packages: new PackagesDir(dataDir),
      collection: repo === null ? unconfiguredCollection(noRepo) : new CollectionGit(repo),
      catalogRoot: dataDir,
      registry: new RegistryHttp(),
      threads: projectSetting === "" ? unconfiguredThreads(noProject) : new ReviewThreads(projectSetting, bbPath, env),
      write: repo === null ? unconfiguredWrite(noRepo) : new CollectionWrite(repo),
      reviews: new KvReviewStore(bb.storage.kv),
      launcher: async (kind) => {
        const result = await checkLaunchers(kind);
        return result.ok ? { ok: true } : { ok: false, message: result.message };
      },
    });
  }

  bb.rpc.register(rpcContract, {
    config: async () => ({ pluginId: bb.pluginId, missing: missingSettings(await settings.get()) }),
    inventory: async () => (await service()).inventory(),
    setEnabled: async (input) => {
      await (await service()).setEnabled(input);
      return null;
    },
    approve: async (input) => {
      await (await service()).approve(input);
      return null;
    },
    auth: async (input) => (await service()).auth(input),
    setSecrets: async (input) => {
      await (await service()).setSecrets(input);
      return null;
    },
    remove: async (input) => {
      await (await service()).remove(input);
      return null;
    },
    update: async (input) => {
      await (await service()).update(input);
      return null;
    },
    collection: async () => (await service()).collection(),
    search: async (input) => (await service()).search(input),
    startReview: async (input) => (await service()).startReview(input),
    reviews: async () => (await service()).reviews(),
    accept: async (input) => {
      await (await service()).accept(input);
      return null;
    },
    reject: async (input) => {
      await (await service()).reject(input);
      return null;
    },
    install: async (input) => (await service()).install(input),
    secretsState: async (input) => (await service()).secretsState(input),
  });
}
