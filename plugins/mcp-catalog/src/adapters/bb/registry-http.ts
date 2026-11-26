import { type RegistryPage, type RegistryPort, parseRegistryPage } from "../../core/registry";

export const GITHUB_REGISTRY_URL = "https://api.mcp.github.com/v0.1/servers";
export const OFFICIAL_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";

/** An MCP registry (official by default, or any with the same `servers` API) over HTTPS; `fetchImpl` is injectable for tests. */
export class RegistryHttp implements RegistryPort {
  constructor(
    private readonly baseUrl: string = OFFICIAL_REGISTRY_URL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = 15_000,
  ) {}

  async search(query: string, cursor?: string): Promise<RegistryPage> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("search", query);
    url.searchParams.set("limit", "30");
    if (cursor !== undefined && cursor !== "") url.searchParams.set("cursor", cursor);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error("реестр MCP недоступен: нет ответа");
    }
    if (!response.ok) throw new Error(`реестр MCP недоступен: ${response.status}`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error("реестр MCP недоступен: неверный ответ");
    }
    return parseRegistryPage(json);
  }
}
