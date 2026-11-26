import { type CollectionIndex, serverSlug } from "./collection";

/** Fields of `bb agent-plugins list --json` the plugin needs. */
export interface BridgePlugin {
  id: string;
  name: string;
  version: string;
  sourceIntent: string;
  status: string;
  lastError: string | null;
}

/** Fields of `bb agent-plugins show <id> --json` `mcpServers[]` the plugin needs; flags are 0/1 as the bridge sends them. */
export interface BridgeServer {
  pluginId: string;
  serverId: string;
  type: string;
  status: string;
  lastError: string | null;
  approved: number;
  enabled: number;
}

export interface BridgePort {
  list(): Promise<BridgePlugin[]>;
  show(id: string): Promise<{ mcpServers: BridgeServer[] }>;
  install(path: string): Promise<{ id: string }>;
  update(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  approve(id: string, serverId: string): Promise<void>;
  auth(id: string, serverId: string): Promise<{ url?: string }>;
  setEnabled(id: string, serverId: string, enabled: boolean): Promise<void>;
  /** Number of tools per `<pluginId>/<serverId>` for the given servers, from one listing. */
  toolCounts(known: { pluginId: string; serverId: string }[]): Promise<Record<string, number>>;
}

/** Secret values never leave the port: `state` reports only whether each key is set. */
export interface SecretsPort {
  state(slug: string): Promise<Record<string, "set" | "missing">>;
  /** An empty string keeps the previous value of that key. */
  write(slug: string, values: Record<string, string>): Promise<void>;
  /** Deletes the listed keys from the slug's stored values. */
  clear(slug: string, keys: string[]): Promise<void>;
  remove(slug: string): Promise<void>;
  /** Absolute path of the env file for the slug. */
  path(slug: string): string;
}

export interface PackagesPort {
  /** Writes the package files and returns the package directory. */
  write(slug: string, files: Record<string, string>): Promise<string>;
  remove(slug: string): Promise<void>;
}

export type Origin = "catalog" | "infra" | "other";

export interface InventoryRow {
  pluginId: string;
  pluginName: string;
  serverId: string;
  status: string;
  enabled: boolean;
  approved: boolean;
  origin: Origin;
  lastError: string | null;
  /** Collection version when it differs from the installed one; catalog rows only. */
  updateAvailable: string | null;
  /** Null when the bridge could not list tools. */
  toolCount: number | null;
}

export function originOf(sourceIntent: string, catalogRoot: string): Origin {
  const root = catalogRoot.replace(/\/+$/, "");
  if (sourceIntent.startsWith(`path:${root}/packages/`)) return "catalog";
  if (sourceIntent.startsWith("path:") && sourceIntent.includes("/bb-mcp-packages/")) return "infra";
  return "other";
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function compareIdentifiers(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** True only when both are `X.Y.Z[-pre]` and `candidate` is strictly newer than `installed`. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const a = SEMVER.exec(candidate);
  const b = SEMVER.exec(installed);
  if (a === null || b === null) return false;
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x > y;
  }
  if (a[4] === undefined) return b[4] !== undefined;
  if (b[4] === undefined) return false;
  return compareIdentifiers(a[4], b[4]) > 0;
}

/** Slug of a catalog package taken from its `path:<catalogRoot>/packages/<slug>` intent; null if not a clean slug. */
export function catalogSlugOf(sourceIntent: string, catalogRoot: string): string | null {
  const prefix = `path:${catalogRoot.replace(/\/+$/, "")}/packages/`;
  if (!sourceIntent.startsWith(prefix)) return null;
  const slug = sourceIntent.slice(prefix.length).replace(/\/+$/, "");
  return SLUG.test(slug) ? slug : null;
}

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function buildInventory(
  plugins: BridgePlugin[],
  servers: BridgeServer[],
  catalogRoot: string,
  collection?: CollectionIndex,
  toolCounts?: Record<string, number>,
): InventoryRow[] {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return servers.flatMap((server) => {
    const plugin = byId.get(server.pluginId);
    if (plugin === undefined) return [];
    const origin = originOf(plugin.sourceIntent, catalogRoot);
    const latest =
      origin === "catalog"
        ? collection?.servers.find((item) => serverSlug(item.name) === server.serverId)?.version
        : undefined;
    return [
      {
        pluginId: plugin.id,
        pluginName: plugin.name,
        serverId: server.serverId,
        status: server.status,
        enabled: server.enabled === 1,
        approved: server.approved === 1,
        origin,
        lastError: server.lastError ?? plugin.lastError,
        updateAvailable: latest !== undefined && isNewerVersion(latest, plugin.version) ? latest : null,
        toolCount: toolCounts === undefined ? null : (toolCounts[`${server.pluginId}/${server.serverId}`] ?? 0),
      },
    ];
  });
}
