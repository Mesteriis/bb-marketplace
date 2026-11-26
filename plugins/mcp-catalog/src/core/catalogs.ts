import type { RegistryMeta, RegistryPort, RegistryServer } from "./registry";

export type CatalogId = "official" | "github" | "docker";

/** Hard cap on registry pages followed to find a version; a server with more versions than this is not expected. */
export const REGISTRY_PAGES = 20;

const DOCKER_PREFIX = "com.docker.mcp/";

const LABELS: Record<CatalogId, string> = { official: "Официальный", github: "GitHub", docker: "Docker" };

export interface CatalogSource {
  id: CatalogId;
  port: RegistryPort;
  /** Exact lookup for catalogs that cannot be paged by name (Docker). */
  lookup?(name: string, version: string): Promise<CatalogRecord | undefined>;
}

/** One catalog record with what the catalog says about running it. */
export interface CatalogRecord {
  server: RegistryServer;
  unsupported?: string;
  /** Network hosts the catalog declares for the server (Docker `run.allowHosts`); information only. */
  allowHosts?: string[];
  /** Some declared hosts were not plain hosts and were left out of `allowHosts`. */
  allowHostsDropped?: boolean;
}

export type CatalogMeta = RegistryMeta & { catalogs: CatalogId[] };

export interface CatalogSearchPage {
  servers: RegistryServer[];
  /** Parallel to `servers`. */
  meta: CatalogMeta[];
  nextCursor?: string;
  warnings: string[];
}

/** Per catalog: a page cursor, "" for «start from the beginning» (nothing fetched yet or the first page failed), null for exhausted. */
type CursorState = Partial<Record<CatalogId, string | null>>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** base64url of the JSON text, built from TextEncoder and btoa so that core does not depend on Node. */
function encodeCursor(state: CursorState): string {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): CursorState {
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    const state: CursorState = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (value !== null && typeof value !== "string") throw new Error("bad value");
      if (id === "official" || id === "github" || id === "docker") state[id] = value;
    }
    return state;
  } catch {
    throw new Error("неверный курсор");
  }
}

/** Search over several MCP catalogs: one cursor pages each of them independently, equal name@version collapse. */
export class CatalogSearch {
  constructor(private readonly sources: CatalogSource[]) {}

  async search(query: string, cursor: string | undefined, enabled: CatalogId[]): Promise<CatalogSearchPage> {
    const state = cursor === undefined || cursor === "" ? undefined : decodeCursor(cursor);
    const active = this.sources.filter((source) => enabled.includes(source.id) && (state === undefined || (state[source.id] ?? null) !== null));
    const outcomes = await Promise.all(
      active.map(async (source) => {
        try {
          return { source, page: await source.port.search(query, state?.[source.id] || undefined) };
        } catch (error) {
          return { source, error };
        }
      }),
    );
    const failures = outcomes.filter((outcome) => "error" in outcome);
    if (failures.length > 0 && failures.length === outcomes.length) throw failures[0]?.error;

    const servers: RegistryServer[] = [];
    const meta: CatalogMeta[] = [];
    const seen = new Map<string, number>();
    const next: CursorState = {};
    const warnings: string[] = [];
    for (const outcome of outcomes) {
      const id = outcome.source.id;
      if ("error" in outcome) {
        warnings.push(`«${LABELS[id]}»: ${messageOf(outcome.error)}`);
        next[id] = state === undefined ? "" : (state[id] ?? null);
        continue;
      }
      next[id] = outcome.page.nextCursor ?? null;
      outcome.page.servers.forEach((server, position) => {
        const key = `${server.name}@${server.version}`;
        const at = seen.get(key);
        const entry = outcome.page.meta?.[position] ?? {};
        if (at === undefined) {
          seen.set(key, servers.length);
          servers.push(server);
          meta.push({ ...entry, catalogs: [id] });
          return;
        }
        const merged = meta[at];
        if (merged === undefined) return;
        if (!merged.catalogs.includes(id)) merged.catalogs.push(id);
        merged.publishedAt ??= entry.publishedAt;
        merged.isLatest ??= entry.isLatest;
      });
    }
    const more = Object.values(next).some((value) => value !== null && value !== undefined);
    return { servers, meta, warnings, ...(more ? { nextCursor: encodeCursor(next) } : {}) };
  }

  /** The record of one name and version: Docker names go to Docker only, the rest to official, then GitHub. */
  async find(name: string, version: string): Promise<CatalogRecord & { catalog: CatalogId }> {
    const order: CatalogId[] = name.startsWith(DOCKER_PREFIX) ? ["docker"] : ["official", "github"];
    let firstError: unknown;
    for (const id of order) {
      const source = this.sources.find((item) => item.id === id);
      if (source === undefined) continue;
      try {
        const found = await this.findIn(source, name, version);
        if (found !== undefined) return { catalog: id, ...found };
      } catch (error) {
        firstError ??= error;
      }
    }
    throw firstError ?? new Error("такой версии сервера нет в реестре");
  }

  private async findIn(
    source: CatalogSource,
    name: string,
    version: string,
  ): Promise<CatalogRecord | undefined> {
    if (source.lookup !== undefined) return source.lookup(name, version);
    let cursor: string | undefined;
    for (let page = 0; page < REGISTRY_PAGES; page++) {
      const result = await source.port.search(name, cursor);
      const at = result.servers.findIndex((server) => server.name === name && server.version === version);
      const server = result.servers[at];
      if (server !== undefined) {
        const unsupported = result.meta?.[at]?.unsupported;
        return { server, ...(unsupported === undefined ? {} : { unsupported }) };
      }
      if (result.nextCursor === undefined) return undefined;
      cursor = result.nextCursor;
    }
    throw new Error(`версия ${version} не найдена в первых ${REGISTRY_PAGES} страницах реестра: уточните запрос`);
  }
}
