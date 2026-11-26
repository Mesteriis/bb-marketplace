import { type CollectionEntry, type CollectionPort, CollectionIndex, loadAcceptedEntry, serverSlug } from "./collection";
import { type DeclaredVariable, declaredVariables } from "./catalog-view";
import {
  type BridgePlugin,
  type BridgePort,
  type PackagesPort,
  type SecretsPort,
  SLUG,
  catalogSlugOf,
  isReplacementVersion,
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

/**
 * The values to write for the declared variables: what the owner typed, plus the server's default for a
 * non-secret variable that is neither typed nor stored. A required variable must end up with a value; every
 * one that does not is named in the error. Pure: nothing is written here.
 */
export function resolveVariableValues(
  variables: DeclaredVariable[],
  typed: Record<string, string>,
  stored: Record<string, "set" | "missing">,
): Record<string, string> {
  const values = { ...typed };
  const missing: string[] = [];
  for (const variable of variables) {
    const isTyped = (values[variable.name] ?? "") !== "";
    const isSet = stored[variable.name] === "set";
    if (!isTyped && !isSet && !variable.isSecret && variable.default !== null && variable.default !== "") {
      values[variable.name] = variable.default;
    }
    if (variable.isRequired && (values[variable.name] ?? "") === "" && !isSet) missing.push(variable.name);
  }
  if (missing.length === 1) throw new Error(`не задана обязательная переменная ${missing[0]}`);
  if (missing.length > 1) throw new Error(`не заданы обязательные переменные: ${missing.join(", ")}`);
  return values;
}

/**
 * The bridge plugin goes first; then the package and the keys file are removed independently. When one of
 * them cannot be, the other is still removed and the error names exactly what is left behind.
 */
export async function removeCatalogServer(deps: InstallDeps, pluginId: string): Promise<void> {
  const { slug } = await catalogPlugin(deps, pluginId);
  await deps.bridge.remove(pluginId);
  const left: string[] = [];
  await deps.packages.remove(slug).catch((error: unknown) => void left.push(`файлы пакета (${messageOf(error)})`));
  await deps.secrets.remove(slug).catch((error: unknown) => void left.push(`файл ключей (${messageOf(error)})`));
  if (left.length > 0) throw new Error(`сервер удалён из моста, но остались данные: ${left.join("; ")}`);
}

/** Names the installed package declared, from its `variables.json`; null when it has none or it is unreadable. */
function declaredBefore(files: Record<string, string> | null): Set<string> | null {
  try {
    const declared = (JSON.parse(files?.["variables.json"] ?? "null") as { declared?: unknown } | null)?.declared;
    return Array.isArray(declared) && declared.every((name) => typeof name === "string") ? new Set(declared as string[]) : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function updateFromCollection(deps: InstallDeps, pluginId: string, requireAccepted: AcceptedCheck): Promise<void> {
  const { plugin, slug } = await catalogPlugin(deps, pluginId);
  const index = CollectionIndex.parse(await deps.collection.readIndex());
  const found = index.servers.find((item) => serverSlug(item.name) === slug);
  if (found === undefined) throw new Error("сервера нет в коллекции");
  if (!isReplacementVersion(found.name, found.version, plugin.version)) throw new Error("обновления нет");
  const { server, entry } = await loadAcceptedEntry(deps.collection, found.name);
  await requireAccepted(entry);
  // Only variables that are new in this version follow the first-install rules: a non-secret one takes the
  // server's default, a required one without any value stops the update before anything is written. A variable
  // the installed version already declared is left alone, so a default the owner cleared does not come back.
  // The installed package records what it declared; when that record is missing or unreadable (installed by
  // an older build) nothing is known to be old: every declared variable gets the required check, none a default.
  const previous = await deps.packages.read(slug);
  const before = declaredBefore(previous);
  const declared = declaredVariables(server, entry);
  const checked = before === null ? declared.map((variable) => ({ ...variable, default: null })) : declared.filter((variable) => !before.has(variable.name));
  const values = resolveVariableValues(checked, {}, await deps.secrets.state(slug));
  const files = generatePackage(server, entry, { envFile: deps.secrets.path(slug) });
  if (Object.keys(values).length > 0) await deps.secrets.write(slug, values);
  await deps.packages.write(slug, files);
  try {
    await deps.bridge.update(pluginId);
  } catch (error) {
    // The bridge still runs the old version: put its files back so that disk and bridge agree.
    if (previous !== null) {
      try {
        await deps.packages.write(slug, previous);
      } catch (restoreError) {
        throw new Error(`${messageOf(error)}; прежние файлы пакета восстановить не удалось: ${messageOf(restoreError)}`, { cause: error });
      }
    }
    throw error;
  }
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
  await deps.secrets.apply(slug, values, clear);
}
