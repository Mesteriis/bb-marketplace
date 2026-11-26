import { createHash } from "node:crypto";
import type { CatalogRecord } from "../../core/catalogs";
import { DOCKER_PAGE_SIZE, DOCKER_PREFIX, allowHostsOf, mapDockerEntry, searchDocker } from "../../core/docker-catalog";
import type { RegistryPage, RegistryPort } from "../../core/registry";

export const DOCKER_CATALOG_URL = "https://desktop.docker.com/mcp/catalog/v3/catalog.json";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const DOCKER_CACHE_MS = 6 * 3600_000;

/** The Docker MCP Catalog: one JSON file fetched at most every 6 hours and searched locally. Fetch and clock are injectable. */
export class DockerCatalogHttp implements RegistryPort {
  private cache: { at: number; entries: Record<string, unknown> } | undefined;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = 30_000,
    private readonly url: string = DOCKER_CATALOG_URL,
  ) {}

  async search(query: string, cursor?: string): Promise<RegistryPage> {
    const offset = cursor === undefined || cursor === "" ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) throw new Error("неверный курсор");
    return searchDocker(await this.entries(), query, offset, DOCKER_PAGE_SIZE, sha256);
  }

  async lookup(name: string, version: string): Promise<CatalogRecord | undefined> {
    if (!name.startsWith(DOCKER_PREFIX)) return undefined;
    const key = name.slice(DOCKER_PREFIX.length);
    const entries = await this.entries();
    if (!Object.hasOwn(entries, key)) return undefined;
    const { server, meta } = mapDockerEntry(key, entries[key], sha256);
    if (server.version !== version) return undefined;
    const allowHosts = allowHostsOf(entries[key]);
    return {
      server,
      ...(meta.unsupported === undefined ? {} : { unsupported: meta.unsupported }),
      ...(allowHosts.hosts.length === 0 ? {} : { allowHosts: allowHosts.hosts }),
      ...(allowHosts.dropped ? { allowHostsDropped: true } : {}),
    };
  }

  private async entries(): Promise<Record<string, unknown>> {
    const at = this.now();
    if (this.cache !== undefined && at - this.cache.at < DOCKER_CACHE_MS) return this.cache.entries;
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new Error("каталог Docker недоступен: нет ответа");
    }
    if (!response.ok) throw new Error(`каталог Docker недоступен: ${response.status}`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error("каталог Docker недоступен: неверный ответ");
    }
    const registry = (json as { registry?: unknown } | null)?.registry;
    if (typeof registry !== "object" || registry === null || Array.isArray(registry)) {
      throw new Error("каталог Docker недоступен: неверный ответ");
    }
    this.cache = { at, entries: registry as Record<string, unknown> };
    return this.cache.entries;
  }
}
