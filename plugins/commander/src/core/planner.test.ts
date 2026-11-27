import { describe, expect, it } from "vitest";
import { buildPlan, revalidate, type PlanRequest, type PlannerDeps } from "./planner.ts";
import { CommanderError } from "./errors.ts";
import {
  OperationPlan,
  planDigest,
  type Capability,
  type Endpoint,
  type EndpointId,
  type Entry,
  type EntryKind,
  type ResourceRef,
} from "./model.ts";
import { displayPath, parent, parsePosix, type ResourcePath } from "./path.ts";
import { LIST_PAGE_MAX, type FileProvider, type ListPage } from "./provider.ts";

const PLAN_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-27T00:00:00.000Z");
const MTIME = "1000000000";

function endpoint(id: string, readOnly = false, caseSensitive = true): Endpoint {
  return {
    id: id as EndpointId,
    provider: "local",
    label: id,
    machine: id,
    hostId: id.slice(5),
    readOnly,
    caseSensitive,
  };
}

function fileEntry(name: string, size = "1"): Entry {
  return {
    name: { t: name },
    kind: "file",
    size,
    mtimeNs: MTIME,
    mtimePrecision: "s",
    mode: null,
    linkTarget: null,
    hidden: false,
  };
}

interface Stored {
  path: ResourcePath;
  entry: Entry;
}

/** In-memory FileProvider for this test file only (S3's fake is not used). */
class MemoryProvider implements FileProvider {
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["list", "stat"]);
  listCalls = 0;
  private readonly byKey = new Map<string, Stored>();
  private readonly childKeys = new Map<string, Set<string>>();

  /** Lookups fold case on a case-insensitive endpoint, as the real filesystem does. */
  private fold(text: string): string {
    return this.endpoint.caseSensitive ? text : text.normalize("NFC").toLowerCase();
  }

  constructor(
    readonly endpoint: Endpoint,
    files: Array<[string, EntryKind, string]>,
    private readonly pageSize = LIST_PAGE_MAX,
  ) {
    for (const [text, kind, size] of files) this.addEntry(text, kind, size);
  }

  addEntry(text: string, kind: EntryKind, size: string): void {
    const path = parsePosix(text);
    const name = path.segments.at(-1);
    if (name === undefined) throw new Error("fixture needs a non-root path");
    const key = this.fold(displayPath(path));
    this.byKey.set(key, { path, entry: { ...fileEntry("", size), name, kind } });
    const parentKey = this.fold(displayPath(parent(path) ?? { segments: [] }));
    const siblings = this.childKeys.get(parentKey) ?? new Set<string>();
    siblings.add(key);
    this.childKeys.set(parentKey, siblings);
  }

  setSize(text: string, size: string): void {
    const stored = this.byKey.get(this.fold(displayPath(parsePosix(text))));
    if (!stored) throw new Error(`no fixture at ${text}`);
    stored.entry = { ...stored.entry, size };
  }

  setKind(text: string, kind: EntryKind): void {
    const stored = this.byKey.get(this.fold(displayPath(parsePosix(text))));
    if (!stored) throw new Error(`no fixture at ${text}`);
    stored.entry = { ...stored.entry, kind };
  }

  async list(
    path: ResourcePath,
    opts: { cursor: string | null; limit: number },
    signal: AbortSignal,
  ): Promise<ListPage> {
    signal.throwIfAborted();
    this.listCalls++;
    const keys = [...(this.childKeys.get(this.fold(displayPath(path))) ?? [])];
    const start = opts.cursor === null ? 0 : Number(opts.cursor);
    const size = Math.min(opts.limit, this.pageSize);
    const page = keys.slice(start, start + size).map((key) => this.byKey.get(key)!.entry);
    const next = start + page.length;
    return { entries: page, cursor: next < keys.length ? String(next) : null };
  }

  async stat(path: ResourcePath, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.byKey.get(this.fold(displayPath(path)))?.entry ?? null;
  }

  async read(): Promise<Uint8Array> {
    throw new CommanderError("unsupported", "fake provider: read is not used by planning");
  }

  async openWrite(): Promise<never> {
    throw new CommanderError("unsupported", "fake provider: write is not used by planning");
  }

  async mkdir(): Promise<void> {
    throw new CommanderError("unsupported", "fake provider: mkdir is not used by planning");
  }

  async rename(): Promise<void> {
    throw new CommanderError("unsupported", "fake provider: rename is not used by planning");
  }

  async remove(): Promise<void> {
    throw new CommanderError("unsupported", "fake provider: remove is not used by planning");
  }
}

/** /src: a.txt (1), b.txt (2), c.txt (3), empty sub/; /out is an existing directory. */
function srcTree(id = "host:x") {
  return new MemoryProvider(endpoint(id), [
    ["/src", "dir", "0"],
    ["/src/a.txt", "file", "1"],
    ["/src/b.txt", "file", "2"],
    ["/src/c.txt", "file", "3"],
    ["/src/sub", "dir", "0"],
    ["/out", "dir", "0"],
  ], 2);
}

function treeProviders(...providers: MemoryProvider[]) {
  return new Map<string, MemoryProvider>(providers.map((p) => [p.endpoint.id, p]));
}

type Overrides = Partial<PlannerDeps>;

function depsFor(providers: Map<string, MemoryProvider>, overrides: Overrides = {}): PlannerDeps {
  return {
    provider: (id) => {
      const provider = providers.get(id);
      if (!provider) throw new Error(`no provider for ${id}`);
      return provider;
    },
    now: () => NOW,
    uuid: () => PLAN_ID,
    limits: { maxItems: 100_000, maxDepth: 64 },
    protectedPathsFor: () => [],
    ...overrides,
  };
}

function ref(endpointId: string, text: string): ResourceRef {
  return { endpoint: endpointId as EndpointId, path: parsePosix(text) };
}

const signal = () => new AbortController().signal;

function copyRequest(sources: ResourceRef[], targetDir: ResourceRef): PlanRequest {
  return {
    kind: "copy",
    initiator: { kind: "owner" },
    sources,
    targetDir,
    newName: null,
    conflictPolicy: "ask",
    verify: "size",
  };
}

function moveRequest(sources: ResourceRef[], targetDir: ResourceRef): PlanRequest {
  return { ...copyRequest(sources, targetDir), kind: "move" };
}

describe("buildPlan on a copy between two endpoints", () => {
  it("expands the tree into 5 items and 6 bytes with a relay route", async () => {
    const src = srcTree("host:x");
    const dst = new MemoryProvider(endpoint("host:y"), [["/dst", "dir", "0"]]);
    const deps = depsFor(treeProviders(src, dst));

    const plan = await buildPlan(
      copyRequest([ref("host:x", "/src")], ref("host:y", "/dst")),
      deps,
      signal(),
    );

    expect(plan.items.length).toBe(5);
    expect(plan.totalBytes).toBe("6");
    expect(plan.route).toBe("relay-server");
    expect(plan.sourceEndpoint).toBe("host:x");
    expect(plan.targetEndpoint).toBe("host:y");
    expect(plan.id).toBe(PLAN_ID);
    expect(plan.createdAt).toBe("2026-11-27T00:00:00.000Z");
    expect(plan.items.map((item) => displayPath(item.source!.path))).toEqual([
      "/src", "/src/a.txt", "/src/b.txt", "/src/c.txt", "/src/sub",
    ]);
    expect(displayPath(plan.items[0].target!.path)).toBe("/dst/src");
    expect(displayPath(plan.items[1].target!.path)).toBe("/dst/src/a.txt");
    expect(plan.items[1].fingerprint).toEqual({ size: "1", mtimeNs: MTIME });
  });

  it("returns a plan that parses and carries the digest of its canonical form", async () => {
    const deps = depsFor(treeProviders(srcTree()));
    const plan = await buildPlan(
      { ...copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), conflictPolicy: "rename", verify: "sha256" },
      deps,
      signal(),
    );

    expect(OperationPlan.parse(plan)).toEqual(plan);
    expect(plan.route).toBe("same-endpoint");
    expect(plan.conflictPolicy).toBe("rename");
    expect(plan.verify).toBe("sha256");
    const { digest, ...unsigned } = plan;
    expect(digest).toBe(await planDigest(unsigned));
  });

  it("takes its own snapshot of the request before the first await", async () => {
    const deps = depsFor(treeProviders(srcTree()));
    const req = copyRequest([ref("host:x", "/src")], ref("host:x", "/out"));
    const pending = buildPlan(req, deps, signal());

    req.initiator = { kind: "agent", threadId: "thr_evil" };
    req.sources[0] = ref("host:x", "/out");
    req.targetDir = null;
    const plan = await pending;

    expect(plan.initiator).toEqual({ kind: "owner" });
    expect(plan.sourceEndpoint).toBe("host:x");
    expect(displayPath(plan.items[0].source!.path)).toBe("/src");
    expect(displayPath(plan.items[0].target!.path)).toBe("/out/src");
    const { digest, ...unsigned } = plan;
    expect(digest).toBe(await planDigest(unsigned));
  });

  it("rejects a total size beyond 20 digits with limit_exceeded", async () => {
    const big = new MemoryProvider(endpoint("host:x"), [
      ["/src", "dir", "0"],
      ["/src/huge", "file", "99999999999999999999"],
      ["/src/one", "file", "1"],
      ["/out", "dir", "0"],
    ]);
    await expect(
      buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), depsFor(treeProviders(big)), signal()),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

describe("buildPlan ordering and kinds", () => {
  it("puts delete children before their directory", async () => {
    const deps = depsFor(treeProviders(srcTree()));
    const plan = await buildPlan(
      {
        kind: "delete",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/src")],
        targetDir: null,
        newName: null,
        conflictPolicy: "ask",
        verify: "size",
      },
      deps,
      signal(),
    );

    expect(plan.items.at(-1)!.source).toEqual(ref("host:x", "/src"));
    expect(plan.items.every((item) => item.target === null)).toBe(true);
    expect(plan.targetEndpoint).toBeNull();
    expect(plan.route).toBe("same-endpoint");
  });

  it("plans mkdir as one item without a source fingerprint", async () => {
    const deps = depsFor(treeProviders(new MemoryProvider(endpoint("host:x"), [["/data", "dir", "0"]])));
    const plan = await buildPlan(
      {
        kind: "mkdir",
        initiator: { kind: "owner" },
        sources: [],
        targetDir: ref("host:x", "/data"),
        newName: { t: "new" },
        conflictPolicy: "ask",
        verify: "size",
      },
      deps,
      signal(),
    );

    expect(plan.items).toEqual([
      {
        source: null,
        target: { endpoint: "host:x", path: parsePosix("/data/new") },
        kind: "dir",
        fingerprint: null,
        expectTarget: "absent",
      },
    ]);
    expect(plan.targetDir).toEqual({ endpoint: "host:x", path: parsePosix("/data") });
    expect(plan.sourceEndpoint).toBeNull();
    expect(plan.totalBytes).toBe("0");
  });

  it("renames a single entry in place without expanding it", async () => {
    const deps = depsFor(treeProviders(srcTree()));
    const plan = await buildPlan(
      {
        kind: "rename",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/src/a.txt")],
        targetDir: null,
        newName: { t: "renamed.txt" },
        conflictPolicy: "ask",
        verify: "size",
      },
      deps,
      signal(),
    );

    expect(plan.items.length).toBe(1);
    expect(displayPath(plan.items[0].target!.path)).toBe("/src/renamed.txt");
    expect(plan.items[0].target!.endpoint).toBe("host:x");
  });

  it("plans a symlink child as a symlink item and does not descend into it", async () => {
    class LyingStat extends MemoryProvider {
      override async stat(path: ResourcePath, signal: AbortSignal) {
        const entry = await super.stat(path, signal);
        if (entry !== null && displayPath(path) === "/src/sub") return { ...entry, kind: "symlink" as const };
        return entry;
      }
    }
    const src = new LyingStat(endpoint("host:x"), [
      ["/src", "dir", "0"],
      ["/src/sub", "dir", "0"],
      ["/src/sub/hidden", "file", "7"],
      ["/out", "dir", "0"],
    ]);
    const plan = await buildPlan(
      copyRequest([ref("host:x", "/src")], ref("host:x", "/out")),
      depsFor(treeProviders(src)),
      signal(),
    );

    expect(plan.items.map((item) => displayPath(item.source!.path))).toEqual(["/src", "/src/sub"]);
    expect(plan.items[1].kind).toBe("symlink");
    expect(src.listCalls).toBe(1);
  });
});

describe("buildPlan limits and streaming", () => {
  function chain(depth: number): string[] {
    const paths = ["/deep"];
    let current = "/deep";
    for (let level = 1; level <= depth; level++) {
      current = `${current}/d${level}`;
      paths.push(current);
    }
    return paths;
  }

  function deepTree(depth: number) {
    return new MemoryProvider(endpoint("host:x"), [
      ...chain(depth).map((text) => [text, "dir", "0"] as [string, EntryKind, string]),
      ["/out", "dir", "0"],
    ]);
  }

  const copyDeep = (depth: number, overrides: Overrides = {}) =>
    buildPlan(
      copyRequest([ref("host:x", "/deep")], ref("host:x", "/out")),
      depsFor(treeProviders(deepTree(depth)), overrides),
      signal(),
    );

  function bigFixture(): Array<[string, EntryKind, string]> {
    const files: Array<[string, EntryKind, string]> = [["/big", "dir", "0"], ["/out", "dir", "0"]];
    for (let index = 0; index < 100_001; index++) files.push([`/big/f${index}`, "file", "0"]);
    return files;
  }

  it("accepts a directory nested 64 levels deep", async () => {
    const plan = await copyDeep(64);
    expect(plan.items.length).toBe(65);
  });

  it("rejects a directory nested 65 levels deep with limit_exceeded", async () => {
    await expect(copyDeep(65)).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("rejects 100001 items with limit_exceeded", async () => {
    const deps = depsFor(treeProviders(new MemoryProvider(endpoint("host:x"), bigFixture())));
    await expect(
      buildPlan(copyRequest([ref("host:x", "/big")], ref("host:x", "/out")), deps, signal()),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("clamps a configured maxItems to the schema limit of 100000", async () => {
    const deps = depsFor(treeProviders(new MemoryProvider(endpoint("host:x"), bigFixture())), {
      limits: { maxItems: 10_000_000, maxDepth: 64 },
    });
    await expect(
      buildPlan(copyRequest([ref("host:x", "/big")], ref("host:x", "/out")), deps, signal()),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("applies a configured maxItems", async () => {
    await expect(
      buildPlan(
        copyRequest([ref("host:x", "/src")], ref("host:x", "/out")),
        depsFor(treeProviders(srcTree()), { limits: { maxItems: 3, maxDepth: 64 } }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("stops listing as soon as the budget runs out on the second page", async () => {
    // Pages of 2 over six children. Root (1), f0 (2), f1 (3) fill page one; f2 (4) fits,
    // f3 (5) exceeds the budget of 4 on page two. A third page must never be requested.
    const src = new MemoryProvider(endpoint("host:x"), [
      ["/src", "dir", "0"],
      ["/src/f0", "file", "0"],
      ["/src/f1", "file", "0"],
      ["/src/f2", "file", "0"],
      ["/src/f3", "file", "0"],
      ["/src/f4", "file", "0"],
      ["/src/f5", "file", "0"],
      ["/out", "dir", "0"],
    ], 2);
    await expect(
      buildPlan(
        copyRequest([ref("host:x", "/src")], ref("host:x", "/out")),
        depsFor(treeProviders(src), { limits: { maxItems: 4, maxDepth: 64 } }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(src.listCalls).toBe(2);
  });

  it("rejects a repeated cursor with internal", async () => {
    class StuckCursor extends MemoryProvider {
      override async list(path: ResourcePath, opts: { cursor: string | null; limit: number }, signal: AbortSignal) {
        const page = await super.list(path, opts, signal);
        return { entries: page.entries, cursor: "stuck" };
      }
    }
    const src = new StuckCursor(endpoint("host:x"), [
      ["/src", "dir", "0"],
      ["/src/a.txt", "file", "1"],
      ["/src/b.txt", "file", "2"],
      ["/out", "dir", "0"],
    ], 1);
    await expect(
      buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), depsFor(treeProviders(src)), signal()),
    ).rejects.toMatchObject({ code: "internal" });
  });
});

describe("buildPlan target directory", () => {
  function targetsFixture() {
    return new MemoryProvider(endpoint("host:x"), [
      ["/src", "dir", "0"],
      ["/src/f", "file", "1"],
      ["/out", "dir", "0"],
      ["/lnk", "symlink", "0"],
      ["/file", "file", "0"],
    ]);
  }

  it("refuses a symlink as the target directory with invalid_path", async () => {
    await expect(
      buildPlan(copyRequest([ref("host:x", "/src/f")], ref("host:x", "/lnk")), depsFor(treeProviders(targetsFixture())), signal()),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("refuses a file as the target directory with invalid_path", async () => {
    await expect(
      buildPlan(copyRequest([ref("host:x", "/src/f")], ref("host:x", "/file")), depsFor(treeProviders(targetsFixture())), signal()),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("reports a missing target directory as not_found", async () => {
    await expect(
      buildPlan(copyRequest([ref("host:x", "/src/f")], ref("host:x", "/nope")), depsFor(treeProviders(targetsFixture())), signal()),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("buildPlan overlaps", () => {
  const overlapFixture = () =>
    new MemoryProvider(endpoint("host:x"), [
      ["/src", "dir", "0"],
      ["/src/a", "file", "1"],
      ["/other", "dir", "0"],
      ["/other/a", "file", "1"],
      ["/out", "dir", "0"],
      ["/out/a", "dir", "0"],
      ["/out/a/b", "file", "1"],
    ]);

  it("rejects the same source listed twice", async () => {
    await expect(
      buildPlan(
        copyRequest([ref("host:x", "/src/a"), ref("host:x", "/src/a")], ref("host:x", "/out")),
        depsFor(treeProviders(overlapFixture())),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects a source that is an ancestor of another source", async () => {
    await expect(
      buildPlan(
        copyRequest([ref("host:x", "/src"), ref("host:x", "/src/a")], ref("host:x", "/out")),
        depsFor(treeProviders(overlapFixture())),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects two computed targets that are the same path", async () => {
    await expect(
      buildPlan(
        copyRequest([ref("host:x", "/src/a"), ref("host:x", "/other/a")], ref("host:x", "/out")),
        depsFor(treeProviders(overlapFixture())),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects a computed target that is an ancestor of another source", async () => {
    // /src/a lands at /out/a, which is an ancestor of the source /out/a/b.
    await expect(
      buildPlan(
        moveRequest([ref("host:x", "/src/a"), ref("host:x", "/out/a/b")], ref("host:x", "/out")),
        depsFor(treeProviders(overlapFixture())),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });
});

describe("buildPlan protected paths", () => {
  function homeFixture() {
    return new MemoryProvider(endpoint("host:x"), [
      ["/home", "dir", "0"],
      ["/home/u", "dir", "0"],
      ["/home/u/x", "file", "1"],
      ["/out", "dir", "0"],
    ]);
  }
  const home = [parsePosix("/home/u")];

  it("refuses to move the home directory", async () => {
    await expect(
      buildPlan(moveRequest([ref("host:x", "/home/u")], ref("host:x", "/out")), depsFor(treeProviders(homeFixture()), { protectedPathsFor: () => home }), signal()),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("refuses to rename the home directory", async () => {
    await expect(
      buildPlan(
        {
          kind: "rename",
          initiator: { kind: "owner" },
          sources: [ref("host:x", "/home/u")],
          targetDir: null,
          newName: { t: "v" },
          conflictPolicy: "ask",
          verify: "size",
        },
        depsFor(treeProviders(homeFixture()), { protectedPathsFor: () => home }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("refuses to delete when the host policy is unknown (null)", async () => {
    await expect(
      buildPlan(
        {
          kind: "delete",
          initiator: { kind: "owner" },
          sources: [ref("host:x", "/home/u/x")],
          targetDir: null,
          newName: null,
          conflictPolicy: "ask",
          verify: "size",
        },
        depsFor(treeProviders(homeFixture()), { protectedPathsFor: () => null }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("allows copying the home directory", async () => {
    const plan = await buildPlan(
      copyRequest([ref("host:x", "/home/u")], ref("host:x", "/out")),
      depsFor(treeProviders(homeFixture()), { protectedPathsFor: () => home }),
      signal(),
    );
    expect(plan.items.length).toBe(2);
  });

  it("refuses to delete the root with permission_denied", async () => {
    await expect(
      buildPlan(
        {
          kind: "delete",
          initiator: { kind: "owner" },
          sources: [ref("host:x", "/")],
          targetDir: null,
          newName: null,
          conflictPolicy: "ask",
          verify: "size",
        },
        depsFor(treeProviders(srcTree())),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("buildPlan guards", () => {
  it("rejects copying a directory into itself with invalid_path", async () => {
    const tree = new MemoryProvider(endpoint("host:x"), [["/a", "dir", "0"], ["/a/f", "file", "1"]]);
    await expect(
      buildPlan(copyRequest([ref("host:x", "/a")], ref("host:x", "/a/b")), depsFor(treeProviders(tree)), signal()),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("refuses to write into a read-only endpoint with read_only", async () => {
    const src = srcTree("host:x");
    const ro = new MemoryProvider(endpoint("host:y", true), [["/dst", "dir", "0"]]);
    await expect(
      buildPlan(copyRequest([ref("host:x", "/src")], ref("host:y", "/dst")), depsFor(treeProviders(src, ro)), signal()),
    ).rejects.toMatchObject({ code: "read_only" });
  });

  it("reports a missing source as not_found", async () => {
    await expect(
      buildPlan(copyRequest([ref("host:x", "/missing")], ref("host:x", "/out")), depsFor(treeProviders(srcTree())), signal()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects sources from more than one endpoint", async () => {
    const other = new MemoryProvider(endpoint("host:y"), [["/z", "file", "1"]]);
    await expect(
      buildPlan(
        copyRequest([ref("host:x", "/src"), ref("host:y", "/z")], ref("host:x", "/out")),
        depsFor(treeProviders(srcTree(), other)),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("stops when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), depsFor(treeProviders(srcTree())), controller.signal),
    ).rejects.toThrow();
  });
});

describe("revalidate", () => {
  const copyPlan = async (src: MemoryProvider, deps: PlannerDeps) =>
    buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), deps, signal());

  it("is ok while the sources are unchanged", async () => {
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const result = await revalidate(await copyPlan(src, deps), deps, signal());
    expect(result.ok).toBe(true);
  });

  it("reports the index of an item whose size changed", async () => {
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const plan = await copyPlan(src, deps);
    src.setSize("/src/a.txt", "9");
    expect(await revalidate(plan, deps, signal())).toEqual({
      ok: false,
      changed: [{ index: 1, reason: "source_changed" }],
    });
  });

  it("rejects a plan whose content no longer matches its digest", async () => {
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const plan = await copyPlan(src, deps);
    const tampered = { ...plan, totalBytes: "0" };
    await expect(revalidate(tampered, deps, signal())).rejects.toMatchObject({ code: "internal" });
  });

  it("re-applies the protection policy to removal items", async () => {
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const plan = await buildPlan(
      {
        kind: "delete",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/src/a.txt")],
        targetDir: null,
        newName: null,
        conflictPolicy: "ask",
        verify: "size",
      },
      deps,
      signal(),
    );
    await expect(
      revalidate(plan, depsFor(treeProviders(src), { protectedPathsFor: () => null }), signal()),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

// ---- Re-review: listing progress, snapshot, target directory, expectTarget ----

function deleteRequest(sources: ResourceRef[]): PlanRequest {
  return {
    kind: "delete",
    initiator: { kind: "owner" },
    sources,
    targetDir: null,
    newName: null,
    conflictPolicy: "ask",
    verify: "size",
  };
}

describe("listing progress and names", () => {
  it("treats an empty page that still has a cursor as internal after one list call", async () => {
    class EmptyPages extends MemoryProvider {
      override async list(): Promise<ListPage> {
        this.listCalls++;
        return { entries: [], cursor: `c${this.listCalls}` };
      }
    }
    const src = new EmptyPages(endpoint("host:x"), [["/src", "dir", "0"], ["/out", "dir", "0"]]);
    await expect(
      buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), depsFor(treeProviders(src)), signal()),
    ).rejects.toMatchObject({ code: "internal" });
    expect(src.listCalls).toBe(1);
  });

  it("ends an endless listing with limit_exceeded", async () => {
    class Endless extends MemoryProvider {
      private pageNo = 0;
      override async list(path: ResourcePath): Promise<ListPage> {
        if (displayPath(path) !== "/src") return { entries: [], cursor: null };
        this.pageNo++;
        return { entries: [fileEntry(`f${this.pageNo}`)], cursor: `c${this.pageNo}` };
      }
      override async stat(path: ResourcePath, signal: AbortSignal) {
        const text = displayPath(path);
        if (text.startsWith("/src/")) return fileEntry(text.slice("/src/".length));
        return super.stat(path, signal);
      }
    }
    const src = new Endless(endpoint("host:x"), [["/src", "dir", "0"], ["/out", "dir", "0"]]);
    await expect(
      buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), depsFor(treeProviders(src)), signal()),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  class ScriptedListing extends MemoryProvider {
    constructor(ep: Endpoint, private readonly pages: string[][]) {
      super(ep, [
        ["/src", "dir", "0"],
        ...pages.flat().map((name) => [`/src/${name}`, "file", "1"] as [string, EntryKind, string]),
      ]);
    }

    override async list(path: ResourcePath, opts: { cursor: string | null; limit: number }, signal: AbortSignal): Promise<ListPage> {
      if (displayPath(path) !== "/src") return super.list(path, opts, signal);
      this.listCalls++;
      const index = opts.cursor === null ? 0 : Number(opts.cursor);
      return {
        entries: this.pages[index].map((name) => fileEntry(name)),
        cursor: index + 1 < this.pages.length ? String(index + 1) : null,
      };
    }
  }

  it("stops a plan when one listing repeats a name across pages", async () => {
    const src = new ScriptedListing(endpoint("host:x"), [["a.txt"], ["a.txt"]]);
    await expect(
      buildPlan(deleteRequest([ref("host:x", "/src")]), depsFor(treeProviders(src)), signal()),
    ).rejects.toMatchObject({ code: "changed_since_plan" });
  });

  it("counts names that differ only by case as repeats on a case-insensitive endpoint", async () => {
    const insensitive = new ScriptedListing(endpoint("host:x", false, false), [["A.txt"], ["a.txt"]]);
    await expect(
      buildPlan(deleteRequest([ref("host:x", "/src")]), depsFor(treeProviders(insensitive)), signal()),
    ).rejects.toMatchObject({ code: "changed_since_plan" });

    const sensitive = new ScriptedListing(endpoint("host:x", false, true), [["A.txt"], ["a.txt"]]);
    await expect(
      buildPlan(deleteRequest([ref("host:x", "/src")]), depsFor(treeProviders(sensitive)), signal()),
    ).resolves.toMatchObject({ kind: "delete" });
  });
});

describe("request limits and rename", () => {
  it("rejects more than 100000 sources with limit_exceeded before validating the request", async () => {
    const many = Array.from({ length: 100_001 }, () => ref("host:x", "/src"));
    await expect(
      buildPlan(copyRequest(many, ref("host:x", "/out")), depsFor(treeProviders(srcTree())), signal()),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("allows a rename that changes only the letter case on a case-insensitive endpoint", async () => {
    const dir = new MemoryProvider(endpoint("host:x", false, false), [["/d", "dir", "0"], ["/d/A", "file", "1"]]);
    const plan = await buildPlan(
      {
        kind: "rename",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/d/A")],
        targetDir: null,
        newName: { t: "a" },
        conflictPolicy: "ask",
        verify: "size",
      },
      depsFor(treeProviders(dir)),
      signal(),
    );
    expect(plan.items.length).toBe(1);
    expect(displayPath(plan.items[0].target!.path)).toBe("/d/a");
  });

  it("rejects a rename to the exact current name with invalid_name", async () => {
    const dir = new MemoryProvider(endpoint("host:x", false, false), [["/d", "dir", "0"], ["/d/A", "file", "1"]]);
    await expect(
      buildPlan(
        {
          kind: "rename",
          initiator: { kind: "owner" },
          sources: [ref("host:x", "/d/A")],
          targetDir: null,
          newName: { t: "A" },
          conflictPolicy: "ask",
          verify: "size",
        },
        depsFor(treeProviders(dir)),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_name" });
  });
});

describe("rename that changes only the Unicode form", () => {
  const request = (newName: string): PlanRequest => ({
    kind: "rename", initiator: { kind: "owner" }, sources: [ref("host:x", "/d/\u00e4")], targetDir: null,
    newName: { t: newName }, conflictPolicy: "ask", verify: "size",
  });

  it("is refused with invalid_name on a case-insensitive endpoint, and no plan is built", async () => {
    const dir = new MemoryProvider(endpoint("host:x", false, false), [["/d", "dir", "0"], ["/d/\u00e4", "file", "1"]]);
    await expect(buildPlan(request("a\u0308"), depsFor(treeProviders(dir)), signal())).rejects.toMatchObject({
      code: "invalid_name", message: "The new name differs from the current name only in Unicode form",
    });
  });

  it("stays a plain rename on a case-sensitive endpoint, where the two forms are different names", async () => {
    const dir = new MemoryProvider(endpoint("host:x", false, true), [["/d", "dir", "0"], ["/d/\u00e4", "file", "1"]]);
    const plan = await buildPlan(request("a\u0308"), depsFor(treeProviders(dir)), signal());
    expect(plan.items.length).toBe(1);
    expect(displayPath(plan.items[0].target!.path)).toBe("/d/a\u0308");
    expect(plan.items[0].expectTarget).toBe("absent");
  });

  it("still accepts a case change combined with a form change on a case-insensitive endpoint", async () => {
    const dir = new MemoryProvider(endpoint("host:x", false, false), [["/d", "dir", "0"], ["/d/\u00e4", "file", "1"]]);
    const plan = await buildPlan(request("A\u0308"), depsFor(treeProviders(dir)), signal());
    expect(displayPath(plan.items[0].target!.path)).toBe("/d/A\u0308");
  });
});

describe("revalidate snapshot and target directory", () => {
  it("checks and returns one snapshot, so a caller's mutation during revalidate changes nothing", async () => {
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const plan = await buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), deps, signal());
    const pending = revalidate(plan, deps, signal());
    plan.conflictPolicy = "overwrite";
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.conflictPolicy).toBe("ask");
  });

  it.each([
    ["mkdir", { kind: "mkdir" as const, sources: [] as ResourceRef[], targetDir: ref("host:x", "/data"), newName: { t: "new" } }],
    ["copy", { kind: "copy" as const, sources: [ref("host:x", "/src/a.txt")], targetDir: ref("host:x", "/data"), newName: null }],
    ["move", { kind: "move" as const, sources: [ref("host:x", "/src/a.txt")], targetDir: ref("host:x", "/data"), newName: null }],
  ])("fails revalidate for %s when the target directory became a symlink", async (_name, shape) => {
    const src = srcTree();
    src.addEntry("/data", "dir", "0");
    const deps = depsFor(treeProviders(src));
    const plan = await buildPlan(
      { initiator: { kind: "owner" }, conflictPolicy: "ask", verify: "size", ...shape },
      deps,
      signal(),
    );
    src.setKind("/data", "symlink");
    await expect(revalidate(plan, deps, signal())).rejects.toMatchObject({ code: "invalid_path" });
  });
});

describe("expectTarget", () => {
  it("records absent for every target that does not exist yet", async () => {
    const plan = await buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), depsFor(treeProviders(srcTree())), signal());
    expect(plan.items.map((item) => item.expectTarget)).toEqual(["absent", "absent", "absent", "absent", "absent"]);
  });

  it("records the target's fingerprint when it already exists, and changed once it moves", async () => {
    const src = srcTree();
    src.addEntry("/out/a.txt", "file", "5");
    const deps = depsFor(treeProviders(src));
    const plan = await buildPlan(copyRequest([ref("host:x", "/src/a.txt")], ref("host:x", "/out")), deps, signal());
    expect(plan.items[0].expectTarget).toEqual({ size: "5", mtimeNs: MTIME });
    src.setSize("/out/a.txt", "6");
    expect(await revalidate(plan, deps, signal())).toEqual({
      ok: false,
      changed: [{ index: 0, reason: "target_changed" }],
    });
  });

  it("reports changed when a target appears after planning", async () => {
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const plan = await buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), deps, signal());
    src.addEntry("/out/src", "dir", "0");
    expect(await revalidate(plan, deps, signal())).toEqual({
      ok: false,
      changed: [{ index: 0, reason: "target_changed" }],
    });
  });
});

describe("digest literal", () => {
  it("matches a SHA-256 computed outside planDigest for a fixed tree, id and time", async () => {
    const src = new MemoryProvider(endpoint("host:x"), [
      ["/src", "dir", "0"],
      ["/src/a.txt", "file", "1"],
      ["/out", "dir", "0"],
    ]);
    const plan = await buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), depsFor(treeProviders(src)), signal());
    // Computed with shasum -a 256 over the hand-written canonical JSON of the expected
    // plan (sorted keys), not with planDigest.
    expect(plan.digest).toBe("2ef62f82151071052c9d928a4fe6fd66f7c81cc8732e6ca0e5d1aa5ddc0da2c9");
    expect(plan.totalBytes).toBe("1");
  });
});

// ---- Third round: self-target rule, case-only rename, page budget, change reasons ----

describe("self-target rule", () => {
  // /d/a/a is an entry inside /d/a. Moving or copying it into /d lands it at /d/a, which
  // is the strict ancestor of its own source. Only an exact same-path rename is exempt.
  function nestedFixture() {
    return new MemoryProvider(endpoint("host:x"), [
      ["/d", "dir", "0"],
      ["/d/a", "dir", "0"],
      ["/d/a/a", "file", "1"],
    ]);
  }

  it("refuses to move /d/a/a into /d: the target /d/a is an ancestor of its own source", async () => {
    await expect(
      buildPlan(moveRequest([ref("host:x", "/d/a/a")], ref("host:x", "/d")), depsFor(treeProviders(nestedFixture())), signal()),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("refuses to copy /d/a/a into /d for the same reason", async () => {
    await expect(
      buildPlan(copyRequest([ref("host:x", "/d/a/a")], ref("host:x", "/d")), depsFor(treeProviders(nestedFixture())), signal()),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("records expectTarget absent for a case-only rename whose target is its own source", async () => {
    const dir = new MemoryProvider(endpoint("host:x", false, false), [["/d", "dir", "0"], ["/d/A", "file", "1"]]);
    const deps = depsFor(treeProviders(dir));
    const plan = await buildPlan(
      {
        kind: "rename",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/d/A")],
        targetDir: null,
        newName: { t: "a" },
        conflictPolicy: "ask",
        verify: "size",
      },
      deps,
      signal(),
    );
    expect(displayPath(plan.items[0].target!.path)).toBe("/d/a");
    expect(plan.items[0].expectTarget).toBe("absent");
    expect((await revalidate(plan, deps, signal())).ok).toBe(true);
  });
});

describe("page budget", () => {
  it("allows 6 list calls for a root with three empty subdirectories, one name per page, maxItems 4", async () => {
    // Root listing: 3 pages (2 with a cursor). Each empty subdirectory: 1 page, no cursor.
    const src = new MemoryProvider(endpoint("host:x"), [
      ["/root", "dir", "0"],
      ["/root/d1", "dir", "0"],
      ["/root/d2", "dir", "0"],
      ["/root/d3", "dir", "0"],
      ["/out", "dir", "0"],
    ], 1);
    const plan = await buildPlan(
      copyRequest([ref("host:x", "/root")], ref("host:x", "/out")),
      depsFor(treeProviders(src), { limits: { maxItems: 4, maxDepth: 64 } }),
      signal(),
    );
    expect(plan.items.length).toBe(4);
    expect(src.listCalls).toBe(6);
  });
});

describe("revalidate change reasons", () => {
  it("reports source_changed when a source moved, and target_changed when a target appeared", async () => {
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const plan = await buildPlan(copyRequest([ref("host:x", "/src")], ref("host:x", "/out")), deps, signal());
    src.setSize("/src/b.txt", "7");
    src.addEntry("/out/src", "dir", "0");
    expect(await revalidate(plan, deps, signal())).toEqual({
      ok: false,
      changed: [
        { index: 0, reason: "target_changed" },
        { index: 2, reason: "source_changed" },
      ],
    });
  });
});

describe("revalidate on a copy whose target matches its source only under case folding", () => {
  it("refuses with invalid_path when the endpoint reports case-insensitive names", async () => {
    const files: Array<[string, EntryKind, string]> = [
      ["/A", "dir", "0"],
      ["/A/f", "file", "1"],
      ["/a", "dir", "0"],
    ];
    const sensitive = new MemoryProvider(endpoint("host:x", false, true), files);
    const plan = await buildPlan(
      copyRequest([ref("host:x", "/A/f")], ref("host:x", "/a")),
      depsFor(treeProviders(sensitive)),
      signal(),
    );
    expect(displayPath(plan.items[0].target!.path)).toBe("/a/f");

    const insensitive = new MemoryProvider(endpoint("host:x", false, false), files);
    await expect(
      revalidate(plan, depsFor(treeProviders(insensitive)), signal()),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });
});

describe("revalidate re-checks target overlaps under the current case rules", () => {
  it("refuses two absent targets that now fold onto one path after the endpoint became case-insensitive", async () => {
    // Copying /d/A and /d/a into an empty /out: distinct targets while the endpoint is case-sensitive.
    const files: Array<[string, EntryKind, string]> = [
      ["/d", "dir", "0"],
      ["/d/A", "file", "1"],
      ["/d/a", "file", "1"],
      ["/out", "dir", "0"],
    ];
    const sensitive = new MemoryProvider(endpoint("host:x", false, true), files);
    const plan = await buildPlan(
      {
        kind: "copy",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/d/A"), ref("host:x", "/d/a")],
        targetDir: ref("host:x", "/out"),
        newName: null,
        conflictPolicy: "ask",
        verify: "size",
      },
      depsFor(treeProviders(sensitive)),
      signal(),
    );
    expect(plan.items.map((item) => displayPath(item.target!.path))).toEqual(["/out/A", "/out/a"]);
    expect(plan.items.map((item) => item.expectTarget)).toEqual(["absent", "absent"]);

    const insensitive = new MemoryProvider(endpoint("host:x", false, false), files);
    await expect(
      revalidate(plan, depsFor(treeProviders(insensitive)), signal()),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });
});
