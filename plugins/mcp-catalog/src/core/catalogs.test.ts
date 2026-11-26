import { describe, expect, it } from "vitest";
import { type CatalogSource, CatalogSearch } from "./catalogs";
import type { RegistryPage, RegistryPort, RegistryServer } from "./registry";

function srv(name: string, version = "1.0.0"): RegistryServer {
  return { name, description: `${name} desc`, version };
}

function port(pages: Record<string, RegistryPage>, calls: Array<string | undefined> = []): RegistryPort {
  return {
    async search(_query, cursor) {
      calls.push(cursor);
      const page = pages[cursor ?? ""];
      if (page === undefined) throw new Error(`no page ${cursor}`);
      return page;
    },
  };
}

const failing: RegistryPort = {
  async search() {
    throw new Error("реестр MCP недоступен: 500");
  },
};

describe("CatalogSearch.search", () => {
  it("merges_same_name_version_into_one_with_both_labels", async () => {
    const search = new CatalogSearch([
      { id: "official", port: port({ "": { servers: [srv("a/x")] } }) },
      { id: "github", port: port({ "": { servers: [srv("a/x"), srv("b/y")] } }) },
    ]);
    const result = await search.search("x", undefined, ["official", "github"]);
    expect(result.servers.map((s) => `${s.name}@${s.version}`)).toEqual(["a/x@1.0.0", "b/y@1.0.0"]);
    expect(result.meta.map((m) => m.catalogs)).toEqual([["official", "github"], ["github"]]);
    expect(result.warnings).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("one_catalog_failure_is_a_warning", async () => {
    const search = new CatalogSearch([
      { id: "official", port: port({ "": { servers: [srv("a/x")] } }) },
      { id: "github", port: failing },
    ]);
    const result = await search.search("x", undefined, ["official", "github"]);
    expect(result.servers).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("«GitHub»");
    expect(result.warnings[0]).toContain("500");
  });

  it("fails_when_every_enabled_catalog_fails", async () => {
    const search = new CatalogSearch([{ id: "official", port: failing }]);
    await expect(search.search("x", undefined, ["official"])).rejects.toThrow("500");
  });

  it("cursor_pages_each_catalog_independently", async () => {
    const officialCalls: Array<string | undefined> = [];
    const githubCalls: Array<string | undefined> = [];
    const search = new CatalogSearch([
      { id: "official", port: port({ "": { servers: [srv("a/x")], nextCursor: "o2" }, o2: { servers: [srv("a/z")] } }, officialCalls) },
      { id: "github", port: port({ "": { servers: [srv("b/y")] } }, githubCalls) },
    ]);
    const first = await search.search("x", undefined, ["official", "github"]);
    expect(first.nextCursor).toBeDefined();
    const second = await search.search("x", first.nextCursor, ["official", "github"]);
    expect(officialCalls).toEqual([undefined, "o2"]);
    expect(githubCalls).toEqual([undefined]);
    expect(second.servers.map((s) => s.name)).toEqual(["a/z"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("failure_on_a_later_page_keeps_that_catalogs_cursor", async () => {
    let githubCalls = 0;
    const github: RegistryPort = {
      async search(_query, cursor) {
        githubCalls++;
        if (cursor === undefined) return { servers: [srv("b/y")], nextCursor: "g2" };
        throw new Error("реестр MCP недоступен: 502");
      },
    };
    const search = new CatalogSearch([
      { id: "official", port: port({ "": { servers: [srv("a/x")], nextCursor: "o2" }, o2: { servers: [srv("a/z")] } }) },
      { id: "github", port: github },
    ]);
    const first = await search.search("x", undefined, ["official", "github"]);
    const second = await search.search("x", first.nextCursor, ["official", "github"]);
    expect(githubCalls).toBe(2);
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toContain("«GitHub»");
    expect(second.nextCursor).toBe("eyJvZmZpY2lhbCI6bnVsbCwiZ2l0aHViIjoiZzIifQ");
  });

  it("failure_on_the_first_page_is_retried_from_the_start_by_the_next_call", async () => {
    const githubCalls: Array<string | undefined> = [];
    const github: RegistryPort = {
      async search(_query, cursor) {
        githubCalls.push(cursor);
        if (githubCalls.length === 1) throw new Error("реестр MCP недоступен: 503");
        return { servers: [srv("b/y")] };
      },
    };
    const search = new CatalogSearch([
      { id: "official", port: port({ "": { servers: [srv("a/x")], nextCursor: "o2" }, o2: { servers: [srv("a/z")] } }) },
      { id: "github", port: github },
    ]);
    const first = await search.search("x", undefined, ["official", "github"]);
    expect(first.nextCursor).toBe("eyJvZmZpY2lhbCI6Im8yIiwiZ2l0aHViIjoiIn0");
    const second = await search.search("x", first.nextCursor, ["official", "github"]);
    expect(githubCalls).toEqual([undefined, undefined]);
    expect(second.servers.map((s) => s.name)).toEqual(["a/z", "b/y"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("cursor_with_non_ascii_state_round_trips", async () => {
    const official: RegistryPort = {
      async search(_query, cursor) {
        return cursor === undefined ? { servers: [srv("a/x")], nextCursor: "стр-2" } : { servers: [srv("a/z")] };
      },
    };
    const search = new CatalogSearch([{ id: "official", port: official }]);
    const first = await search.search("x", undefined, ["official"]);
    expect(first.nextCursor).toBe("eyJvZmZpY2lhbCI6ItGB0YLRgC0yIn0");
    const second = await search.search("x", first.nextCursor, ["official"]);
    expect(second.servers.map((s) => s.name)).toEqual(["a/z"]);
  });

  it("merged_unsupported_comes_from_the_first_catalog_that_listed_it", async () => {
    const search = new CatalogSearch([
      { id: "official", port: port({ "": { servers: [srv("a/x")] } }) },
      { id: "github", port: port({ "": { servers: [srv("a/x")], meta: [{ unsupported: "нет" }] } }) },
    ]);
    const result = await search.search("x", undefined, ["official", "github"]);
    expect(result.meta[0]?.unsupported).toBeUndefined();
    expect(result.meta[0]?.catalogs).toEqual(["official", "github"]);
  });

  it("disabled_catalog_is_not_queried", async () => {
    const githubCalls: Array<string | undefined> = [];
    const search = new CatalogSearch([
      { id: "official", port: port({ "": { servers: [srv("a/x")] } }) },
      { id: "github", port: port({ "": { servers: [srv("b/y")] } }, githubCalls) },
    ]);
    const result = await search.search("x", undefined, ["official"]);
    expect(githubCalls).toEqual([]);
    expect(result.servers.map((s) => s.name)).toEqual(["a/x"]);
  });

  it("carries_unsupported_from_meta", async () => {
    const search = new CatalogSearch([{ id: "official", port: port({ "": { servers: [srv("a/x")], meta: [{ unsupported: "нет пакета" }] } }) }]);
    const result = await search.search("x", undefined, ["official"]);
    expect(result.meta[0]).toEqual({ unsupported: "нет пакета", catalogs: ["official"] });
  });

  it("rejects_a_malformed_cursor", async () => {
    const search = new CatalogSearch([{ id: "official", port: port({}) }]);
    await expect(search.search("x", "!!!", ["official"])).rejects.toThrow("неверный курсор");
  });
});

describe("CatalogSearch.find", () => {
  function sources(calls: string[]): CatalogSource[] {
    const make = (id: CatalogSource["id"], names: string[]): CatalogSource => ({
      id,
      port: {
        async search() {
          calls.push(id);
          return { servers: names.map((n) => srv(n)) };
        },
      },
    });
    return [make("official", ["a/x"]), make("github", ["a/x", "g/only"]), make("docker", ["com.docker.mcp/pg"])];
  }

  it("find_routes_docker_names_to_docker", async () => {
    const calls: string[] = [];
    const found = await new CatalogSearch(sources(calls)).find("com.docker.mcp/pg", "1.0.0");
    expect(found.catalog).toBe("docker");
    expect(calls).toEqual(["docker"]);
  });

  it("find_uses_docker_lookup_when_present", async () => {
    const docker: CatalogSource = {
      id: "docker",
      port: failing,
      lookup: async (name, version) => ({ server: srv(name, version), unsupported: "нужны тома (volumes)", allowHosts: ["a.example"] }),
    };
    const found = await new CatalogSearch([docker]).find("com.docker.mcp/pg", "9.9.9");
    expect(found.server.version).toBe("9.9.9");
    expect(found.unsupported).toBe("нужны тома (volumes)");
    expect(found.allowHosts).toEqual(["a.example"]);
  });

  it("find_prefers_official_then_github", async () => {
    const calls: string[] = [];
    const search = new CatalogSearch(sources(calls));
    expect((await search.find("a/x", "1.0.0")).catalog).toBe("official");
    expect(calls).toEqual(["official"]);
    expect((await search.find("g/only", "1.0.0")).catalog).toBe("github");
  });

  it("find_reports_unsupported_from_meta", async () => {
    const source: CatalogSource = { id: "official", port: port({ "": { servers: [srv("a/x")], meta: [{ unsupported: "нет" }] } }) };
    expect((await new CatalogSearch([source]).find("a/x", "1.0.0")).unsupported).toBe("нет");
  });

  it("find_follows_pages_up_to_the_cap", async () => {
    const endless: RegistryPort = { search: async () => ({ servers: [], nextCursor: "n" }) };
    await expect(new CatalogSearch([{ id: "official", port: endless }]).find("a/x", "1.0.0")).rejects.toThrow("первых 20 страницах");
  });

  it("find_says_when_the_version_is_missing", async () => {
    await expect(new CatalogSearch([{ id: "official", port: port({ "": { servers: [] } }) }]).find("a/x", "1.0.0")).rejects.toThrow(
      "такой версии сервера нет в реестре",
    );
  });
});
