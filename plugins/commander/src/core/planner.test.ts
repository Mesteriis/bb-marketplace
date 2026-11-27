import { describe, expect, it } from "vitest";
import { buildPlan, revalidate, type PlannerDeps } from "./planner.ts";
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

function endpoint(id: string, readOnly = false): Endpoint {
  return {
    id: id as EndpointId,
    provider: "local",
    label: id,
    machine: id,
    hostId: id.slice(5),
    readOnly,
    caseSensitive: true,
  };
}

interface Stored {
  path: ResourcePath;
  entry: Entry;
}

/** In-memory FileProvider for this test file only (S3's fake is not used). */
class MemoryProvider implements FileProvider {
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["list", "stat"]);
  private readonly byKey = new Map<string, Stored>();
  private readonly childKeys = new Map<string, string[]>();

  constructor(
    readonly endpoint: Endpoint,
    files: Array<[string, EntryKind, string]>,
    private readonly pageSize = LIST_PAGE_MAX,
  ) {
    for (const [text, kind, size] of files) {
      const path = parsePosix(text);
      const name = path.segments.at(-1);
      if (name === undefined) throw new Error("fixture needs a non-root path");
      const entry: Entry = {
        name,
        kind,
        size,
        mtimeNs: MTIME,
        mtimePrecision: "s",
        mode: null,
        linkTarget: null,
        hidden: false,
      };
      const key = displayPath(path);
      this.byKey.set(key, { path, entry });
      const parentKey = displayPath(parent(path) ?? { segments: [] });
      const siblings = this.childKeys.get(parentKey) ?? [];
      siblings.push(key);
      this.childKeys.set(parentKey, siblings);
    }
  }

  setSize(text: string, size: string): void {
    const stored = this.byKey.get(displayPath(parsePosix(text)));
    if (!stored) throw new Error(`no fixture at ${text}`);
    stored.entry = { ...stored.entry, size };
  }

  async list(
    path: ResourcePath,
    opts: { cursor: string | null; limit: number },
    signal: AbortSignal,
  ): Promise<ListPage> {
    signal.throwIfAborted();
    const keys = this.childKeys.get(displayPath(path)) ?? [];
    const start = opts.cursor === null ? 0 : Number(opts.cursor);
    const size = Math.min(opts.limit, this.pageSize);
    const page = keys.slice(start, start + size).map((key) => this.byKey.get(key)!.entry);
    const next = start + page.length;
    return { entries: page, cursor: next < keys.length ? String(next) : null };
  }

  async stat(path: ResourcePath, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.byKey.get(displayPath(path))?.entry ?? null;
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

/** /src holds a.txt (1), b.txt (2), c.txt (3) and an empty sub/ directory. */
function treeProviders(source: MemoryProvider, extra: MemoryProvider[] = []) {
  const providers = new Map<string, MemoryProvider>([[source.endpoint.id, source]]);
  for (const other of extra) providers.set(other.endpoint.id, other);
  return providers;
}

function srcTree(id = "host:x") {
  return new MemoryProvider(endpoint(id), [
    ["/src", "dir", "0"],
    ["/src/a.txt", "file", "1"],
    ["/src/b.txt", "file", "2"],
    ["/src/c.txt", "file", "3"],
    ["/src/sub", "dir", "0"],
  ], 2);
}

function depsFor(
  providers: Map<string, MemoryProvider>,
  overrides: Partial<PlannerDeps> = {},
): PlannerDeps {
  return {
    provider: (id) => {
      const provider = providers.get(id);
      if (!provider) throw new Error(`no provider for ${id}`);
      return provider;
    },
    now: () => NOW,
    uuid: () => PLAN_ID,
    limits: { maxItems: 100_000, maxDepth: 64 },
    ...overrides,
  };
}

function ref(endpointId: string, text: string): ResourceRef {
  return { endpoint: endpointId as EndpointId, path: parsePosix(text) };
}

const signal = () => new AbortController().signal;

describe("buildPlan on a copy between two endpoints", () => {
  it("expands the tree into 5 items and 6 bytes with a relay route", async () => {
    const src = srcTree("host:x");
    const dst = new MemoryProvider(endpoint("host:y"), [["/dst", "dir", "0"]]);
    const deps = depsFor(treeProviders(src, [dst]));

    const plan = await buildPlan(
      {
        kind: "copy",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/src")],
        targetDir: ref("host:y", "/dst"),
        newName: null,
        conflictPolicy: "ask",
        verify: "size",
      },
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
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const plan = await buildPlan(
      {
        kind: "copy",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/src")],
        targetDir: ref("host:x", "/out"),
        newName: null,
        conflictPolicy: "rename",
        verify: "sha256",
      },
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
      },
    ]);
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
});

describe("buildPlan limits", () => {
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
    return new MemoryProvider(
      endpoint("host:x"),
      chain(depth).map((text) => [text, "dir", "0"] as [string, EntryKind, string]),
    );
  }

  const copyDeep = (depth: number, overrides: Partial<PlannerDeps> = {}) =>
    buildPlan(
      {
        kind: "copy",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/deep")],
        targetDir: ref("host:x", "/out"),
        newName: null,
        conflictPolicy: "ask",
        verify: "size",
      },
      depsFor(treeProviders(deepTree(depth)), overrides),
      signal(),
    );

  it("accepts a directory nested 64 levels deep", async () => {
    const plan = await copyDeep(64);
    expect(plan.items.length).toBe(65);
  });

  it("rejects a directory nested 65 levels deep with limit_exceeded", async () => {
    await expect(copyDeep(65)).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("rejects 100001 items with limit_exceeded", async () => {
    const files: Array<[string, EntryKind, string]> = [["/big", "dir", "0"]];
    for (let index = 0; index < 100_001; index++) files.push([`/big/f${index}`, "file", "0"]);
    const deps = depsFor(treeProviders(new MemoryProvider(endpoint("host:x"), files)));

    await expect(
      buildPlan(
        {
          kind: "copy",
          initiator: { kind: "owner" },
          sources: [ref("host:x", "/big")],
          targetDir: ref("host:x", "/out"),
          newName: null,
          conflictPolicy: "ask",
          verify: "size",
        },
        deps,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("applies a configured maxItems", async () => {
    await expect(
      buildPlan(
        {
          kind: "copy",
          initiator: { kind: "owner" },
          sources: [ref("host:x", "/src")],
          targetDir: ref("host:x", "/out"),
          newName: null,
          conflictPolicy: "ask",
          verify: "size",
        },
        depsFor(treeProviders(srcTree()), { limits: { maxItems: 3, maxDepth: 64 } }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

describe("revalidate", () => {
  it("is ok while the sources are unchanged", async () => {
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const plan = await buildPlan(
      {
        kind: "copy",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/src")],
        targetDir: ref("host:x", "/out"),
        newName: null,
        conflictPolicy: "ask",
        verify: "size",
      },
      deps,
      signal(),
    );
    expect(await revalidate(plan, deps, signal())).toEqual({ ok: true });
  });

  it("reports the index of an item whose size changed", async () => {
    const src = srcTree();
    const deps = depsFor(treeProviders(src));
    const plan = await buildPlan(
      {
        kind: "copy",
        initiator: { kind: "owner" },
        sources: [ref("host:x", "/src")],
        targetDir: ref("host:x", "/out"),
        newName: null,
        conflictPolicy: "ask",
        verify: "size",
      },
      deps,
      signal(),
    );
    src.setSize("/src/a.txt", "9");
    expect(await revalidate(plan, deps, signal())).toEqual({ ok: false, changed: [1] });
  });
});

describe("buildPlan guards", () => {
  const request = (overrides: Record<string, unknown>) => ({
    kind: "copy" as const,
    initiator: { kind: "owner" as const },
    sources: [ref("host:x", "/a")],
    targetDir: ref("host:x", "/a/b"),
    newName: null,
    conflictPolicy: "ask" as const,
    verify: "size" as const,
    ...overrides,
  });

  const aTree = () =>
    new MemoryProvider(endpoint("host:x"), [
      ["/a", "dir", "0"],
      ["/a/f", "file", "1"],
    ]);

  it("rejects copying a directory into itself with invalid_path", async () => {
    await expect(buildPlan(request({}), depsFor(treeProviders(aTree())), signal())).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("refuses to delete the root with permission_denied", async () => {
    await expect(
      buildPlan(
        request({ kind: "delete", sources: [ref("host:x", "/")], targetDir: null }),
        depsFor(treeProviders(aTree())),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("refuses to delete the home directory with permission_denied", async () => {
    await expect(
      buildPlan(
        request({ kind: "delete", sources: [ref("host:x", "/a")], targetDir: null }),
        depsFor(treeProviders(aTree()), { protectedPaths: [parsePosix("/a")] }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("refuses to write into a read-only endpoint with read_only", async () => {
    const ro = new MemoryProvider(endpoint("host:y", true), [["/dst", "dir", "0"]]);
    await expect(
      buildPlan(
        request({ sources: [ref("host:x", "/a")], targetDir: ref("host:y", "/dst") }),
        depsFor(treeProviders(aTree(), [ro])),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "read_only" });
  });

  it("reports a missing source as not_found", async () => {
    await expect(
      buildPlan(
        request({ sources: [ref("host:x", "/missing")], targetDir: ref("host:x", "/out") }),
        depsFor(treeProviders(aTree())),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects sources from more than one endpoint", async () => {
    const other = new MemoryProvider(endpoint("host:y"), [["/z", "file", "1"]]);
    await expect(
      buildPlan(
        request({ sources: [ref("host:x", "/a"), ref("host:y", "/z")], targetDir: ref("host:x", "/out") }),
        depsFor(treeProviders(aTree(), [other])),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("stops when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildPlan(request({ targetDir: ref("host:x", "/out") }), depsFor(treeProviders(aTree())), controller.signal),
    ).rejects.toThrow();
  });
});
