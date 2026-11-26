import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RegistryHttp } from "./registry-http";

const page = readFileSync(fileURLToPath(new URL("../../core/fixtures/registry-page.json", import.meta.url)), "utf8");

function fakeFetch(respond: () => Response) {
  const urls: string[] = [];
  const impl = (async (input: URL | string) => {
    urls.push(String(input));
    return respond();
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe("RegistryHttp", () => {
  it("requests search with limit 30 and parses the page", async () => {
    const { impl, urls } = fakeFetch(() => new Response(page));
    const result = await new RegistryHttp(impl).search("git hub");
    expect(urls).toEqual(["https://registry.modelcontextprotocol.io/v0/servers?search=git+hub&limit=30"]);
    expect(result.servers.length).toBeGreaterThan(0);
  });

  it("passes the cursor", async () => {
    const { impl, urls } = fakeFetch(() => new Response(page));
    await new RegistryHttp(impl).search("x", "c1");
    expect(urls[0]).toContain("&cursor=c1");
  });

  it("turns an HTTP error into a Russian message with the status", async () => {
    const { impl } = fakeFetch(() => new Response("no", { status: 503 }));
    await expect(new RegistryHttp(impl).search("x")).rejects.toThrow("реестр MCP недоступен: 503");
  });

  it("aborts after the timeout", async () => {
    const impl = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(new RegistryHttp(impl, 20).search("x")).rejects.toThrow("реестр MCP недоступен: нет ответа");
  });

  it("wraps a network failure", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new RegistryHttp(impl).search("x")).rejects.toThrow("реестр MCP недоступен: нет ответа");
  });

  it("wraps a body that is not JSON", async () => {
    const { impl } = fakeFetch(() => new Response("<html>"));
    await expect(new RegistryHttp(impl).search("x")).rejects.toThrow("реестр MCP недоступен: неверный ответ");
  });
});
