import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RemoteSourceResult } from "../../core/repo-catalog.ts";
import { nodeScanFs } from "./node-scan-fs.ts";
import { RepoCatalogService } from "./repo-catalog-service.ts";

let home: string;
let data: string;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "gw-catalog-"));
  home = join(base, "home");
  data = join(base, "data");
  mkdirSync(home);
  mkdirSync(data);
});
afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

function gitRepo(path: string, origin?: string): void {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "config"), origin ? `[remote "origin"]\n\turl = ${origin}\n` : "[core]\n");
}

const SRC = { id: "github.com/Example", kind: "github" as const, host: "github.com", account: "Example" };
const listing = (ok = true): RemoteSourceResult[] => [
  {
    source: SRC,
    ok,
    error: ok ? null : "gh did not answer in time for Example",
    fetchedAt: ok ? "2026-11-26T09:00:00.000Z" : null,
    repos: ok
      ? [
          { fullName: "Example/one", description: null, private: true, archived: false, fork: false, cloneUrl: "git@github.com:Example/one.git", webUrl: "https://github.com/Example/one", updatedAt: null },
          { fullName: "Example/two", description: null, private: true, archived: false, fork: false, cloneUrl: "git@github.com:Example/two.git", webUrl: "https://github.com/Example/two", updatedAt: null },
        ]
      : [],
  },
];

function service(listRemote: () => Promise<RemoteSourceResult[]>, roots = "~/projects") {
  return new RepoCatalogService({
    dataDir: data,
    home,
    fs: nodeScanFs,
    settings: async () => ({ roots, depth: 4 }),
    listRemote,
    now: () => new Date("2026-11-26T10:00:00.000Z"),
  });
}

describe("RepoCatalogService", () => {
  it("scans the roots and marks cloned remote repositories", async () => {
    gitRepo(join(home, "projects", "one"), "https://github.com/example/one.git");
    gitRepo(join(home, "projects", "group", "scratch"));
    let calls = 0;
    const s = service(async () => (calls++, listing()));
    const c = await s.catalog();

    const one = join(home, "projects", "one");
    const scratch = join(home, "projects", "group", "scratch");
    expect(c.local).toEqual([
      { path: scratch, name: "scratch", remote: null },
      { path: one, name: "one", remote: "github.com/example/one" },
    ]);
    expect(c.remote.map((r) => [r.fullName, r.localPath])).toEqual([
      ["Example/one", one],
      ["Example/two", null],
    ]);
    expect(c.roots).toEqual([{ root: join(home, "projects"), ok: true }]);
    expect(c.scannedAt).toBe("2026-11-26T10:00:00.000Z");
    expect(calls).toBe(1);
  });

  it("asks the forges only on the first catalog and on refresh, also after a restart", async () => {
    let calls = 0;
    const list = async () => (calls++, listing());
    await service(list).catalog();
    await service(list).catalog();
    expect(calls).toBe(1);
    await service(list).refresh();
    expect(calls).toBe(2);
  });

  it("runs one listing for concurrent refreshes", async () => {
    let calls = 0;
    const s = service(async () => (calls++, listing()));
    await Promise.all([s.refresh(), s.refresh(), s.catalog()]);
    expect(calls).toBe(1);
  });

  it("keeps the last repositories of a source whose refresh failed", async () => {
    let ok = true;
    const s = service(async () => listing(ok));
    await s.catalog();
    ok = false;
    const c = await s.refresh();
    expect(c.sources).toEqual([{ ...SRC, ok: false, error: "gh did not answer in time for Example", count: 2, fetchedAt: "2026-11-26T09:00:00.000Z" }]);
    expect(c.remote).toHaveLength(2);
  });

  it("keeps the cached repositories of a failed source after a restart", async () => {
    await service(async () => listing(true)).catalog();
    const c = await service(async () => listing(false)).refresh();
    expect(c.remote).toHaveLength(2);
    expect(c.sources[0]).toMatchObject({ ok: false, count: 2 });
  });

  it("reports a root it cannot use", async () => {
    const c = await service(async () => [], "~/projects, relative/dir").catalog();
    expect(c.roots).toEqual([
      { root: join(home, "projects"), ok: false },
      { root: "relative/dir", ok: false },
    ]);
  });
});
