import { describe, expect, it } from "vitest";
import { DockerCatalogHttp } from "./docker-catalog-http";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const catalog = JSON.stringify({
  registry: {
    brave: { type: "server", title: "Brave", description: "Search", image: `mcp/brave@${DIGEST}`, run: { allowHosts: ["api.search.example:443"] } },
    mail: { type: "server", title: "Mail", description: "Sends mail", image: `mcp/mail@${DIGEST}`, volumes: ["a:/b"] },
  },
});

function setup(respond: () => Response = () => new Response(catalog)) {
  const urls: string[] = [];
  const clock = { now: 0 };
  const fetchImpl = (async (input: URL | string) => {
    urls.push(String(input));
    return respond();
  }) as unknown as typeof fetch;
  const http = new DockerCatalogHttp(fetchImpl, () => clock.now);
  return { http, urls, clock };
}

describe("DockerCatalogHttp", () => {
  it("fetches the catalog URL and searches it", async () => {
    const { http, urls } = setup();
    const page = await http.search("brave");
    expect(urls).toEqual(["https://desktop.docker.com/mcp/catalog/v3/catalog.json"]);
    expect(page.servers.map((s) => s.name)).toEqual(["com.docker.mcp/brave"]);
  });

  it("pages by offset cursor", async () => {
    const { http } = setup();
    expect((await http.search("", "1")).servers.map((s) => s.name)).toEqual(["com.docker.mcp/mail"]);
  });

  it("serves_from_cache_within_6_hours_then_refetches", async () => {
    const { http, urls, clock } = setup();
    await http.search("a");
    clock.now = 6 * 3600_000 - 1;
    await http.search("b");
    expect(urls).toHaveLength(1);
    clock.now = 6 * 3600_000;
    await http.search("c");
    expect(urls).toHaveLength(2);
  });

  it("http_error_is_a_clear_message", async () => {
    const { http } = setup(() => new Response("no", { status: 503 }));
    await expect(http.search("a")).rejects.toThrow("каталог Docker недоступен: 503");
  });

  it("network_failure_and_bad_json_are_clear_messages", async () => {
    const down = new DockerCatalogHttp((async () => { throw new Error("x"); }) as unknown as typeof fetch);
    await expect(down.search("a")).rejects.toThrow("каталог Docker недоступен: нет ответа");
    const { http } = setup(() => new Response("<html>"));
    await expect(http.search("a")).rejects.toThrow("каталог Docker недоступен: неверный ответ");
    const { http: noRegistry } = setup(() => new Response("{}"));
    await expect(noRegistry.search("a")).rejects.toThrow("каталог Docker недоступен: неверный ответ");
  });

  it("failed_fetch_is_not_cached", async () => {
    let ok = false;
    const { http } = setup(() => (ok ? new Response(catalog) : new Response("", { status: 500 })));
    await expect(http.search("a")).rejects.toThrow();
    ok = true;
    expect((await http.search("brave")).servers).toHaveLength(1);
  });

  it("remote_only_record_gets_the_real_content_version", async () => {
    const remoteOnly = JSON.stringify({ registry: { ex: { type: "remote", description: "d", remote: { transport_type: "sse", url: "https://mcp.example.com/sse" } } } });
    const { http } = setup(() => new Response(remoteOnly));
    expect((await http.search("ex")).servers[0]?.version).toBe("sha256-3f0873de25c6");
    expect((await http.lookup("com.docker.mcp/ex", "sha256-3f0873de25c6"))?.server.name).toBe("com.docker.mcp/ex");
  });

  it("lookup_returns_record_with_allow_hosts", async () => {
    const { http } = setup();
    const found = await http.lookup("com.docker.mcp/brave", "sha256-abababababab");
    expect(found?.server.name).toBe("com.docker.mcp/brave");
    expect(found?.allowHosts).toEqual(["api.search.example:443"]);
    expect(found?.unsupported).toBeUndefined();
  });

  it("lookup_reports_unsupported_and_misses", async () => {
    const { http } = setup();
    expect((await http.lookup("com.docker.mcp/mail", "sha256-abababababab"))?.unsupported).toBe("нужны тома (volumes)");
    expect(await http.lookup("com.docker.mcp/none", "latest")).toBeUndefined();
    expect(await http.lookup("com.docker.mcp/brave", "sha256-000000000000")).toBeUndefined();
    expect(await http.lookup("io.other/brave", "sha256-abababababab")).toBeUndefined();
  });
});
