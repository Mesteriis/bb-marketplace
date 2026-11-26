import { type CollectionEntry, type CollectionPort, CollectionIndex, loadAcceptedEntry, serverSlug } from "./collection";
import { declaredVariables } from "./catalog-view";
import {
  type BridgePlugin,
  type BridgePort,
  type PackagesPort,
  type SecretsPort,
  SLUG,
  catalogSlugOf,
  isNewerVersion,
  originOf,
} from "./inventory";
import { generatedServerId, generatePackage, pluginName } from "./package-gen";

export interface InstallDeps {
  bridge: BridgePort;
  secrets: SecretsPort;
  packages: PackagesPort;
  collection: CollectionPort;
  /** The plugin data dir: catalog packages live in `<catalogRoot>/packages/`. */
  catalogRoot: string;
}

/** Throws unless this catalog accepted exactly this entry; runs before anything is written. */
export type AcceptedCheck = (entry: CollectionEntry) => Promise<void>;

function requireSlug(slug: string): string {
  if (!SLUG.test(slug)) throw new Error("недопустимое имя сервера");
  return slug;
}

async function isNameTaken(bridge: BridgePort, slug: string): Promise<boolean> {
  const plugins = await bridge.list();
  if (plugins.some((plugin) => plugin.name === pluginName(slug))) return true;
  for (const plugin of plugins) {
    const { mcpServers } = await bridge.show(plugin.id);
    if (mcpServers.some((server) => server.serverId === generatedServerId(slug))) return true;
  }
  return false;
}

/** Re-reads the plugin from the bridge; trusts nothing the caller says about it. */
async function catalogPlugin(deps: InstallDeps, pluginId: string): Promise<{ plugin: BridgePlugin; slug: string }> {
  const plugin = (await deps.bridge.list()).find((item) => item.id === pluginId);
  if (plugin === undefined) throw new Error("плагина нет среди стоящих");
  const origin = originOf(plugin.sourceIntent, deps.catalogRoot);
  if (origin === "infra") throw new Error("серверы из infra удаляются в infra");
  if (origin !== "catalog") throw new Error("работает только с серверами из каталога");
  const slug = catalogSlugOf(plugin.sourceIntent, deps.catalogRoot);
  if (slug === null) throw new Error("недопустимое имя сервера");
  return { plugin, slug };
}

export async function installFromCollection(
  deps: InstallDeps,
  name: string,
  values: Record<string, string>,
  requireAccepted: AcceptedCheck,
): Promise<{ pluginId: string; needsApproval: true }> {
  const { server, entry } = await loadAcceptedEntry(deps.collection, name);
  await requireAccepted(entry);
  const slug = requireSlug(serverSlug(entry.name));
  if (await isNameTaken(deps.bridge, slug)) throw new Error("сервер с таким именем уже стоит");
  // Generation is pure and may reject the entry, so it runs before anything is written.
  const files = generatePackage(server, entry, { envFile: deps.secrets.path(slug) });
  try {
    await deps.secrets.write(slug, values);
    const dir = await deps.packages.write(slug, files);
    const { id } = await deps.bridge.install(dir);
    return { pluginId: id, needsApproval: true };
  } catch (error) {
    // Secrets stay: the owner already typed them and the retry reuses them.
    await deps.packages.remove(slug).catch(() => undefined);
    throw error;
  }
}

export async function removeCatalogServer(deps: InstallDeps, pluginId: string): Promise<void> {
  const { slug } = await catalogPlugin(deps, pluginId);
  await deps.bridge.remove(pluginId);
  await deps.packages.remove(slug);
  await deps.secrets.remove(slug);
}

export async function updateFromCollection(deps: InstallDeps, pluginId: string, requireAccepted: AcceptedCheck): Promise<void> {
  const { plugin, slug } = await catalogPlugin(deps, pluginId);
  const index = CollectionIndex.parse(await deps.collection.readIndex());
  const found = index.servers.find((item) => serverSlug(item.name) === slug);
  if (found === undefined) throw new Error("сервера нет в коллекции");
  if (!isNewerVersion(found.version, plugin.version)) throw new Error("обновления нет");
  const { server, entry } = await loadAcceptedEntry(deps.collection, found.name);
  await requireAccepted(entry);
  const files = generatePackage(server, entry, { envFile: deps.secrets.path(slug) });
  await deps.packages.write(slug, files);
  await deps.bridge.update(pluginId);
}

/** The registry entry behind an installed catalog plugin; the plugin is re-read from the bridge and must come from the catalog. */
export async function loadCatalogEntry(deps: InstallDeps, pluginId: string) {
  const { slug } = await catalogPlugin(deps, pluginId);
  const index = CollectionIndex.parse(await deps.collection.readIndex());
  const found = index.servers.find((item) => serverSlug(item.name) === slug);
  if (found === undefined) throw new Error("сервера нет в коллекции");
  return { slug, ...(await loadAcceptedEntry(deps.collection, found.name, index)) };
}

/** Replaces or clears variables of an installed catalog server; only variables the server declares may be touched. */
export async function setCatalogSecrets(
  deps: InstallDeps,
  pluginId: string,
  values: Record<string, string>,
  clear: string[],
): Promise<void> {
  const { slug, server, entry } = await loadCatalogEntry(deps, pluginId);
  const declared = new Set(declaredVariables(server, entry).map((variable) => variable.name));
  for (const key of [...Object.keys(values), ...clear]) {
    if (!declared.has(key)) throw new Error(`переменная «${key}» не объявлена сервером`);
  }
  const typed = Object.entries(values).filter(([, value]) => value !== "").map(([key]) => key);
  if (clear.some((key) => typed.includes(key))) throw new Error("переменную нельзя одновременно задать и очистить");
  await deps.secrets.write(slug, values);
  await deps.secrets.clear(slug, clear);
}
