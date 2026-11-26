import { describe, expect, it } from "vitest";
import fixture from "./fixtures/registry-page.json";
import { parseRegistryPage, RegistryServer } from "./registry";

describe("parseRegistryPage", () => {
  it("takes servers[].server and metadata.nextCursor", () => {
    const page = parseRegistryPage(fixture);
    expect(page.servers).toHaveLength(2);
    expect(page.servers[0]?.name).toBe(fixture.servers[0]?.server.name);
    expect(page.nextCursor).toBe(fixture.metadata.nextCursor);
  });

  it("skips an entry without a name", () => {
    expect(fixture.servers).toHaveLength(3);
    const names = parseRegistryPage(fixture).servers.map((s) => s.name);
    expect(names).not.toContain(undefined);
    expect(names).toHaveLength(2);
  });

  it("returns an empty page for non-registry input", () => {
    expect(parseRegistryPage(null)).toEqual({ servers: [] });
    expect(parseRegistryPage({ servers: "x" })).toEqual({ servers: [] });
  });

  it("omits nextCursor when the registry sends none", () => {
    expect(parseRegistryPage({ servers: [], metadata: {} })).toEqual({ servers: [] });
  });

  it("keeps unknown fields", () => {
    const page = parseRegistryPage({
      servers: [{ server: { name: "a/b", description: "d", version: "1", extra: 1 } }],
    });
    expect(page.servers[0]).toMatchObject({ extra: 1 });
  });

  it("parses packages and remotes", () => {
    const server = RegistryServer.parse({
      name: "a/b",
      description: "d",
      version: "1",
      packages: [
        {
          registryType: "npm",
          identifier: "pkg",
          transport: { type: "stdio" },
          environmentVariables: [{ name: "TOKEN", isRequired: true, isSecret: true }],
        },
      ],
      remotes: [{ type: "sse", url: "https://example.com/sse" }],
    });
    expect(server.packages?.[0]?.environmentVariables?.[0]?.isSecret).toBe(true);
    expect(server.remotes?.[0]?.type).toBe("sse");
  });

  it("keeps publishedAt and isLatest from _meta alongside the servers", () => {
    const page = parseRegistryPage(fixture);
    expect(page.meta?.[0]).toEqual({ publishedAt: "2026-11-20T16:05:37.129799Z", isLatest: true });
    expect(page.meta).toHaveLength(page.servers.length);
  });

  it("has no meta when no entry carries it", () => {
    const page = parseRegistryPage({ servers: [{ server: { name: "a/b", description: "d", version: "1" } }] });
    expect(page.meta).toBeUndefined();
  });
});
