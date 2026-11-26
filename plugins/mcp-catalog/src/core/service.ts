import { type CatalogId, type CatalogMeta, type CatalogSource, CatalogSearch } from "./catalogs";
import { type CollectionEntry, CollectionIndex, loadAcceptedEntry, serverSlug } from "./collection";
import { declaredVariables, launcherKindOf, reviewSummary, sourcesOf, type LauncherKind } from "./catalog-view";
import type {
  CollectionResult,
  InstallResult,
  InventoryResult,
  ReviewItem,
  ReviewsResult,
  SearchItem,
  SearchResult,
  SecretsStateResult,
} from "./contract";
import {
  type InstallDeps,
  installFromCollection,
  loadCatalogEntry,
  removeCatalogServer,
  resolveVariableValues,
  setCatalogSecrets,
  updateFromCollection,
} from "./install";
import { buildInventory, isNewerVersion, type BridgePlugin, type BridgeServer } from "./inventory";
import { DOCKER_PREFIX, ociDigestOf } from "./docker-catalog";
import { pluginName } from "./package-gen";
import type { RegistryPort, RegistryServer } from "./registry";
import {
  type CollectionWritePort,
  type ReviewRecord,
  type ThreadsPort,
  advanceReview,
  reviewPrompt,
  reviewTitle,
} from "./review";

export type LauncherCheck = (kind: LauncherKind) => Promise<{ ok: true } | { ok: false; message: string }>;

/** Persistent review records, one per registry server name and version. */
export interface ReviewStore {
  list(): Promise<ReviewRecord[]>;
  put(record: ReviewRecord): Promise<void>;
}

export interface ServiceDeps extends InstallDeps {
  /** The official MCP registry. */
  registry: RegistryPort;
  /** Further catalogs searched next to the official one. */
  extraSources?: CatalogSource[];
  threads: ThreadsPort;
  write: CollectionWritePort;
  reviews: ReviewStore;
  launcher: LauncherCheck;
  now?: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toItem(rec: ReviewRecord): ReviewItem {
  return { name: rec.name, version: rec.version, state: rec.state, error: rec.error ?? null, threadId: rec.threadId };
}

type Group = Pick<SearchItem, "name" | "latestVersion" | "versions" | "catalogs" | "unsupported">;

/** One group per server name: versions newest first, the latest one by the registry's flag or else the highest semver. */
function groupByName(servers: RegistryServer[], meta: CatalogMeta[]): Group[] {
  type Acc = { versions: SearchItem["versions"]; flagged?: string; catalogs: CatalogId[]; unsupported: Map<string, string> };
  const groups = new Map<string, Acc>();
  servers.forEach((server, position) => {
    const group: Acc = groups.get(server.name) ?? { versions: [], catalogs: [], unsupported: new Map() };
    groups.set(server.name, group);
    const entry = meta[position];
    for (const id of entry?.catalogs ?? []) if (!group.catalogs.includes(id)) group.catalogs.push(id);
    if (group.versions.some((item) => item.version === server.version)) return;
    group.versions.push({
      version: server.version,
      publishedAt: entry?.publishedAt ?? null,
      description: server.description,
      sources: sourcesOf(server),
      unsupported: entry?.unsupported ?? null,
      reviewing: false,
    });
    if (entry?.isLatest === true) group.flagged = server.version;
    if (entry?.unsupported !== undefined) group.unsupported.set(server.version, entry.unsupported);
  });
  return [...groups].map(([name, group]) => {
    const versions = [...group.versions].sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0));
    const latestVersion = group.flagged ?? versions[0]?.version ?? "";
    return { name, latestVersion, versions, catalogs: group.catalogs, unsupported: group.unsupported.get(latestVersion) ?? null };
  });
}

/** The plugin's use cases behind the RPC; the host entry point only registers these. */
export function createService(deps: ServiceDeps) {
  const now = deps.now ?? Date.now;
  const catalogs = new CatalogSearch([{ id: "official", port: deps.registry }, ...(deps.extraSources ?? [])]);

  /**
   * The review the owner means. With a version: exactly that one. Without one (older callers): the newest
   * review of the name that is in one of `states`, or else the newest of the name, so the state check
   * can say why it cannot be used.
   */
  async function findRecord(name: string, version: string | undefined, states: ReviewRecord["state"][]): Promise<ReviewRecord> {
    const named = (await deps.reviews.list()).filter((item) => item.name === name);
    const pool = version !== undefined ? named.filter((item) => item.version === version) : named.some((item) => states.includes(item.state)) ? named.filter((item) => states.includes(item.state)) : named;
    // Docker versions are digests with no order: the most recently started review is the newest.
    const later = (item: ReviewRecord, best: ReviewRecord) =>
      name.startsWith(DOCKER_PREFIX) ? (item.startedAt ?? 0) > (best.startedAt ?? 0) : isNewerVersion(item.version, best.version);
    const newest = pool.reduce<ReviewRecord | undefined>((best, item) => (best === undefined || later(item, best) ? item : best), undefined);
    if (newest === undefined) throw new Error("проверки для этого сервера нет");
    return newest;
  }

  async function findInRegistry(name: string, version: string): Promise<RegistryServer> {
    return (await catalogs.find(name, version)).server;
  }

  /**
   * The trust chain: an entry on origin/main is installable here only if this catalog's owner accepted
   * exactly that name and version, and the recorded accept commit really reached origin/main.
   */
  async function requireAccepted(entry: CollectionEntry): Promise<void> {
    const rec = (await deps.reviews.list()).find(
      (item) => item.name === entry.name && item.version === entry.version && item.state === "accepted",
    );
    const ok =
      rec !== undefined &&
      typeof rec.acceptCommit === "string" &&
      rec.acceptCommit !== "" &&
      (await deps.collection.isAccepted(rec.acceptCommit));
    if (!ok) throw new Error("запись не принята в этом каталоге");
  }

  async function installedSlugs(): Promise<(slug: string) => boolean> {
    const names = new Set((await deps.bridge.list()).map((plugin) => plugin.name));
    return (slug) => names.has(pluginName(slug));
  }

  return {
    async inventory(): Promise<InventoryResult> {
      const warnings: string[] = [];
      const plugins: BridgePlugin[] = await deps.bridge.list();
      const servers: BridgeServer[] = [];
      await Promise.all(
        plugins.map(async (plugin) => {
          try {
            servers.push(...(await deps.bridge.show(plugin.id)).mcpServers);
          } catch (error) {
            warnings.push(`${plugin.name}: ${messageOf(error)}`);
          }
        }),
      );
      let index: CollectionIndex | undefined;
      try {
        index = CollectionIndex.parse(await deps.collection.readIndex());
      } catch (error) {
        warnings.push(`коллекция недоступна, обновления не проверены: ${messageOf(error)}`);
      }
      let toolCounts: Record<string, number> | undefined;
      try {
        const listed = await deps.bridge.toolCounts(servers.map(({ pluginId, serverId }) => ({ pluginId, serverId })));
        toolCounts = listed.counts;
        if (listed.skipped > 0) warnings.push(`инструментов, которые не удалось сопоставить с сервером: ${listed.skipped}; в числах они не учтены`);
      } catch (error) {
        warnings.push(`число инструментов недоступно: ${messageOf(error)}`);
      }
      const order = new Map(plugins.map((plugin, position) => [plugin.id, position]));
      servers.sort((a, b) => (order.get(a.pluginId) ?? 0) - (order.get(b.pluginId) ?? 0) || a.serverId.localeCompare(b.serverId));
      return { rows: buildInventory(plugins, servers, deps.catalogRoot, index, toolCounts), warnings };
    },

    setEnabled: (input: { pluginId: string; serverId: string; enabled: boolean }) =>
      deps.bridge.setEnabled(input.pluginId, input.serverId, input.enabled),
    approve: (input: { pluginId: string; serverId: string }) => deps.bridge.approve(input.pluginId, input.serverId),
    async auth(input: { pluginId: string; serverId: string }): Promise<{ url: string | null }> {
      return { url: (await deps.bridge.auth(input.pluginId, input.serverId)).url ?? null };
    },
    setSecrets: (input: { pluginId: string; values: Record<string, string>; clear: string[] }) =>
      setCatalogSecrets(deps, input.pluginId, input.values, input.clear),
    remove: (input: { pluginId: string }) => removeCatalogServer(deps, input.pluginId),
    update: (input: { pluginId: string }) => updateFromCollection(deps, input.pluginId, requireAccepted),

    async collection(): Promise<CollectionResult> {
      const index = CollectionIndex.parse(await deps.collection.readIndex());
      const isInstalled = await installedSlugs();
      const items = await Promise.all(
        index.servers.map(async (item) => {
          const installed = isInstalled(serverSlug(item.name));
          try {
            const { review } = await loadAcceptedEntry(deps.collection, item.name, index);
            return { name: item.name, version: item.version, summary: reviewSummary(review), error: null, installed };
          } catch (error) {
            return { name: item.name, version: item.version, summary: "", error: messageOf(error), installed };
          }
        }),
      );
      return { items };
    },

    async search(input: { query: string; cursor?: string; catalogs?: CatalogId[] }): Promise<SearchResult> {
      const page = await catalogs.search(input.query, input.cursor, input.catalogs ?? ["official", "github", "docker"]);
      const isInstalled = await installedSlugs();
      const reviewing = new Set((await deps.reviews.list()).filter((rec) => rec.state === "reviewing").map((rec) => `${rec.name}@${rec.version}`));
      const warnings = [...page.warnings];
      let inCollection = new Set<string>();
      try {
        inCollection = new Set(CollectionIndex.parse(await deps.collection.readIndex()).servers.map((item) => item.name));
      } catch (error) {
        warnings.push(`коллекция недоступна, пометки «в коллекции» нет: ${messageOf(error)}`);
      }
      const items = groupByName(page.servers, page.meta).map((group) => {
        const versions = group.versions.map((item) => ({ ...item, reviewing: reviewing.has(`${group.name}@${item.version}`) }));
        return {
          ...group,
          versions,
          installed: isInstalled(serverSlug(group.name)),
          inCollection: inCollection.has(group.name),
          reviewing: versions.some((item) => item.reviewing),
        };
      });
      return { items, nextCursor: page.nextCursor ?? null, warning: warnings.length === 0 ? null : warnings.join("; ") };
    },

    async startReview(input: { name: string; version: string }): Promise<ReviewItem> {
      const existing = (await deps.reviews.list()).find((item) => item.name === input.name && item.version === input.version);
      if (existing?.state === "accepted") throw new Error("эта версия уже принята в коллекцию");
      if (existing !== undefined && (existing.state === "reviewing" || existing.state === "ready")) {
        throw new Error("проверка этого сервера уже идёт или ждёт решения");
      }
      const { server, unsupported, allowHosts, allowHostsDropped } = await catalogs.find(input.name, input.version);
      if (unsupported !== undefined) throw new Error(`не поддерживается: ${unsupported}`);
      let prompt: string;
      let title: string;
      try {
        prompt = reviewPrompt(server, server.name.startsWith(DOCKER_PREFIX) ? { ociDigest: ociDigestOf(server), allowHosts, allowHostsDropped } : {});
        title = reviewTitle(server);
      } catch (error) {
        const failed: ReviewRecord = {
          name: server.name,
          version: server.version,
          threadId: "",
          state: "failed",
          error: messageOf(error),
        };
        await deps.reviews.put(failed);
        return toItem(failed);
      }
      const { threadId } = await deps.threads.spawnReview(prompt, title);
      const rec: ReviewRecord = {
        name: server.name,
        version: server.version,
        threadId,
        state: "reviewing",
        startedAt: now(),
      };
      await deps.reviews.put(rec);
      return toItem(rec);
    },

    async reviews(): Promise<ReviewsResult> {
      const records = await deps.reviews.list();
      const items: ReviewItem[] = [];
      for (const rec of records) {
        let current = rec;
        try {
          current = await advanceReview(rec, deps.threads, deps.write, now());
        } catch {
          // The thread cannot be read right now; the record stays as it was and the next request tries again.
        }
        if (current !== rec) await deps.reviews.put(current);
        items.push(toItem(current));
      }
      return { items: items.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true })) };
    },

    async accept(input: { name: string; version?: string }): Promise<void> {
      const rec = await findRecord(input.name, input.version, ["ready"]);
      if (rec.state !== "ready") throw new Error("принять можно только проверку, которая закончена");
      if (rec.worktree === undefined) throw new Error("у проверки нет рабочего дерева");
      // The committed server.json must be the registry's record for the reviewed name and version.
      const expected = await findInRegistry(rec.name, rec.version);
      try {
        const { commit } = await deps.write.accept(rec.worktree, serverSlug(rec.name), {
          push: true,
          acceptedCommit: rec.acceptCommit,
          expected,
        });
        await deps.reviews.put({ ...rec, state: "accepted", acceptCommit: commit });
        deps.collection.invalidate?.();
      } catch (error) {
        const commit = (error as { acceptCommit?: unknown } | null)?.acceptCommit;
        if (typeof commit === "string" && commit !== "") await deps.reviews.put({ ...rec, acceptCommit: commit });
        throw error;
      }
    },

    async reject(input: { name: string; version?: string }): Promise<void> {
      const rec = await findRecord(input.name, input.version, ["ready", "failed"]);
      if (rec.state !== "ready" && rec.state !== "failed") throw new Error("отклонить можно только законченную или упавшую проверку");
      if (rec.worktree !== undefined) await deps.write.reject(rec.worktree);
      await deps.reviews.put({ ...rec, state: "rejected" });
    },

    async secretsState(input: { name: string } | { pluginId: string }): Promise<SecretsStateResult> {
      const { server, entry } =
        "pluginId" in input ? await loadCatalogEntry(deps, input.pluginId) : await loadAcceptedEntry(deps.collection, input.name);
      const state = await deps.secrets.state(serverSlug(entry.name));
      return {
        variables: declaredVariables(server, entry).map((variable) => ({
          name: variable.name,
          description: variable.description,
          isRequired: variable.isRequired,
          isSecret: variable.isSecret,
          state: state[variable.name] === "set" ? "set" : "missing",
        })),
      };
    },

    async install(input: { name: string; values: Record<string, string> }): Promise<InstallResult> {
      const { server, entry } = await loadAcceptedEntry(deps.collection, input.name);
      await requireAccepted(entry);
      const variables = declaredVariables(server, entry);
      const declared = new Set(variables.map((variable) => variable.name));
      // Only declared variables are written: the env file is sourced by the launch script.
      for (const key of Object.keys(input.values)) {
        if (!declared.has(key)) throw new Error(`переменная «${key}» не объявлена сервером`);
      }
      // An empty value keeps what is stored; with nothing stored, a non-secret variable takes the server's
      // default, and a required one must end up set.
      const stored = await deps.secrets.state(serverSlug(entry.name));
      const values = resolveVariableValues(variables, input.values, stored);
      const kind = launcherKindOf(server, entry);
      if (kind !== null) {
        const launcher = await deps.launcher(kind);
        if (!launcher.ok) return { ok: false, message: launcher.message };
      }
      const { pluginId, needsApproval } = await installFromCollection(deps, input.name, values, requireAccepted);
      return { ok: true, pluginId, needsApproval };
    },
  };
}
export type CatalogService = ReturnType<typeof createService>;
