import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../core/collection";
import type { RegistryServer } from "../../core/registry";
import { CollectionWrite } from "./collection-write";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

const SLUG = "io-example-demo";
let origin: string;
let main: string;
let wt: string;
let write: CollectionWrite;

async function put(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

interface Spec {
  name?: string;
  slug?: string;
  version?: string;
  hash?: string;
  index?: boolean;
  /** Index lines the reviewer left besides this entry's own line. */
  others?: { name: string; version: string; path: string }[];
}

const serverOf = (name: string, version: string) => ({ name, description: "d", version });

async function writeEntry(root: string, over: Spec = {}) {
  const name = over.name ?? "io.example/demo";
  const slug = over.slug ?? SLUG;
  const version = over.version ?? "1.0.0";
  const serverText = `${JSON.stringify(serverOf(name, version))}\n`;
  const entry = {
    name, version,
    serverJsonSha256: over.hash ?? (await sha256Hex(serverText)),
    choice: { kind: "package", index: 0 },
  };
  await put(root, `mcp-collection/${slug}/server.json`, serverText);
  await put(root, `mcp-collection/${slug}/review.md`, "ok\n");
  await put(root, `mcp-collection/${slug}/entry.json`, JSON.stringify(entry));
  if (over.index !== false) {
    await put(root, "mcp-collection/index.json", JSON.stringify({ servers: [...(over.others ?? []), { name, version, path: `mcp-collection/${slug}` }] }));
  }
}

/** Accept options with the registry record the service would refetch. */
const opts = (extra: { push?: boolean; acceptedCommit?: string; name?: string; version?: string; server?: unknown } = {}) => ({
  push: extra.push ?? false,
  ...(extra.acceptedCommit === undefined ? {} : { acceptedCommit: extra.acceptedCommit }),
  expected: (extra.server ?? serverOf(extra.name ?? "io.example/demo", extra.version ?? "1.0.0")) as RegistryServer,
});

const indexOnMain = () => JSON.parse(run(main, "show", "HEAD:mcp-collection/index.json")).servers;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-write-"));
  origin = join(root, "origin.git");
  main = join(root, "main");
  wt = join(root, "review");
  run(root, "init", "--bare", "-b", "main", origin);
  run(root, "clone", origin, main);
  run(main, "checkout", "-b", "main");
  await put(main, "README.md", "x");
  run(main, "add", "-A");
  run(main, "commit", "-m", "init");
  run(main, "push", "origin", "main");
  run(main, "worktree", "add", "-b", "bb/review", wt);
  write = new CollectionWrite(main);
});

describe("branchHasEntry", () => {
  it("is false without files", async () => {
    expect(await write.branchHasEntry(wt, SLUG)).toBe(false);
  });
  it("is true for a complete entry", async () => {
    await writeEntry(wt);
    expect(await write.branchHasEntry(wt, SLUG)).toBe(true);
  });
  it("is false on a hash mismatch or a missing index line", async () => {
    await writeEntry(wt, { hash: "0".repeat(64) });
    expect(await write.branchHasEntry(wt, SLUG)).toBe(false);
  });
  it("is false without the index", async () => {
    await writeEntry(wt, { index: false });
    expect(await write.branchHasEntry(wt, SLUG)).toBe(false);
  });
});

describe("accept", () => {
  it("commits in the worktree, merges into main and pushes", async () => {
    await writeEntry(wt);
    await write.accept(wt, SLUG, opts({ push: true }));
    expect(run(main, "log", "-1", "--format=%s")).toContain("Merge mcp-collection io-example-demo");
    expect(run(main, "show", "HEAD:mcp-collection/index.json")).toContain("io.example/demo");
    expect(run(wt, "log", "-1", "--format=%B")).toContain("mcp-collection: accept io.example/demo 1.0.0");
    expect(run(wt, "log", "-1", "--format=%B")).toContain("Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
    expect(run(origin, "rev-parse", "main").trim()).toBe(run(main, "rev-parse", "main").trim());
  });
  it("does not push when push is false", async () => {
    await writeEntry(wt);
    const before = run(origin, "rev-parse", "main").trim();
    await write.accept(wt, SLUG, opts());
    expect(run(origin, "rev-parse", "main").trim()).toBe(before);
    expect(run(main, "show", "HEAD:mcp-collection/index.json")).toContain("io.example/demo");
  });
  it("refuses a dirty main checkout and changes nothing", async () => {
    await writeEntry(wt);
    await put(main, "README.md", "dirty");
    const head = run(main, "rev-parse", "HEAD").trim();
    const wtHead = run(wt, "rev-parse", "HEAD").trim();
    await expect(write.accept(wt, SLUG, opts())).rejects.toThrow("основная копия bb-main не на main или с незакоммиченными правками");
    expect(run(main, "rev-parse", "HEAD").trim()).toBe(head);
    expect(run(wt, "rev-parse", "HEAD").trim()).toBe(wtHead);
  });
  it("refuses a main checkout on another branch", async () => {
    await writeEntry(wt);
    run(main, "checkout", "-b", "other");
    const head = run(main, "rev-parse", "HEAD").trim();
    await expect(write.accept(wt, SLUG, opts())).rejects.toThrow("не на main");
    expect(run(main, "rev-parse", "HEAD").trim()).toBe(head);
  });
  it("aborts the merge on a conflict and a retry then merges the committed entry", async () => {
    await writeEntry(wt);
    await put(main, `mcp-collection/${SLUG}/review.md`, "someone else's report\n");
    run(main, "add", "-A");
    run(main, "commit", "-m", "conflicting entry file");
    run(main, "push", "origin", "main");
    const failure = await write.accept(wt, SLUG, opts()).then(() => null, (error: Error & { acceptCommit?: string }) => error);
    expect(failure?.message).toBe("не удалось слить запись коллекции: конфликт");
    expect(failure?.acceptCommit).toBe(run(wt, "rev-parse", "HEAD").trim());
    expect(run(main, "status", "--porcelain").trim()).toBe("");
    // without the recorded SHA the earlier commit is not trusted
    await expect(write.accept(wt, SLUG, opts())).rejects.toThrow(/посторонние коммиты/);
    // the owner fixes main; the entry is already committed in the worktree
    run(main, "reset", "--hard", "HEAD~1");
    run(main, "push", "-f", "origin", "main");
    await expect(write.accept(wt, SLUG, opts({ acceptedCommit: "0".repeat(40) }))).rejects.toThrow(/посторонние коммиты/);
    const result = await write.accept(wt, SLUG, opts({ acceptedCommit: failure?.acceptCommit }));
    expect(result.commit).toBe(failure?.acceptCommit);
    expect(run(main, "show", "HEAD:mcp-collection/index.json")).toContain("io.example/demo");
  });
  it("refuses a reviewer commit that borrows the accept subject, forged index included", async () => {
    await writeEntry(wt);
    await put(wt, "mcp-collection/index.json", JSON.stringify({ servers: [
      { name: "io.example/demo", version: "1.0.0", path: `mcp-collection/${SLUG}` },
      { name: "evil/x", version: "1.0.0", path: "mcp-collection/evil-x" },
    ] }));
    run(wt, "add", "-A");
    run(wt, "commit", "-m", "mcp-collection: accept io.example/demo 1.0.0");
    const head = run(main, "rev-parse", "HEAD").trim();
    await expect(write.accept(wt, SLUG, opts())).rejects.toThrow(/посторонние коммиты/);
    expect(run(main, "rev-parse", "HEAD").trim()).toBe(head);
  });
  it("writes acceptedAt at accept time; the reviewer draft has none", async () => {
    await writeEntry(wt);
    expect(await write.branchHasEntry(wt, SLUG)).toBe(true);
    await write.accept(wt, SLUG, opts());
    const entry = JSON.parse(run(main, "show", `HEAD:mcp-collection/${SLUG}/entry.json`));
    expect(Date.parse(entry.acceptedAt)).not.toBeNaN();
  });
  describe("refuses and leaves main untouched", () => {
    const untouched = async (message: RegExp) => {
      const head = run(main, "rev-parse", "HEAD").trim();
      await expect(write.accept(wt, SLUG, opts())).rejects.toThrow(message);
      expect(run(main, "rev-parse", "HEAD").trim()).toBe(head);
      expect(run(main, "status", "--porcelain").trim()).toBe("");
    };
    it("an extra file outside the slug", async () => {
      await writeEntry(wt);
      await put(wt, "src/evil.ts", "x");
      await untouched(/вне записи/);
    });
    it("a second index change", async () => {
      await writeEntry(wt, { others: [{ name: "other/x", version: "1.0.0", path: "mcp-collection/other-x" }] });
      await untouched(/индекс/);
    });
    it("a server.json that differs from the registry record", async () => {
      await writeEntry(wt);
      const head = run(main, "rev-parse", "HEAD").trim();
      await expect(write.accept(wt, SLUG, opts({ server: { ...serverOf("io.example/demo", "1.0.0"), description: "other" } }))).rejects.toThrow(/реестра/);
      expect(run(main, "rev-parse", "HEAD").trim()).toBe(head);
    });
    it("an entry for another name or version than the review", async () => {
      await writeEntry(wt);
      const head = run(main, "rev-parse", "HEAD").trim();
      await expect(write.accept(wt, SLUG, opts({ version: "1.0.1" }))).rejects.toThrow(/не та, что проверялась/);
      await expect(write.accept(wt, SLUG, opts({ name: "io.example/other" }))).rejects.toThrow(/не та, что проверялась/);
      expect(run(main, "rev-parse", "HEAD").trim()).toBe(head);
    });
    it("a commit made by the reviewer", async () => {
      await writeEntry(wt);
      run(wt, "add", "-A");
      run(wt, "commit", "-m", "reviewer commit");
      await untouched(/коммит/);
    });
    it("a worktree of another repository", async () => {
      const other = await mkdtemp(join(tmpdir(), "other-repo-"));
      run(other, "init", "-b", "main");
      await put(other, "a", "1");
      run(other, "add", "-A");
      run(other, "commit", "-m", "i");
      await writeEntry(other);
      await expect(write.accept(other, SLUG, opts())).rejects.toThrow(/не рабочее дерево/);
    });
    it("the main checkout itself", async () => {
      await writeEntry(main);
      await expect(write.accept(main, SLUG, opts())).rejects.toThrow(/не рабочее дерево/);
    });
    it("a local main that differs from origin/main", async () => {
      await writeEntry(wt);
      await put(main, "x.txt", "1");
      run(main, "add", "-A");
      run(main, "commit", "-m", "unpushed");
      await untouched(/origin\/main/);
    });
  });
  it("reports a failed push and leaves main merged", async () => {
    await writeEntry(wt);
    run(main, "remote", "set-url", "--push", "origin", "/nonexistent/origin.git");
    await expect(write.accept(wt, SLUG, opts({ push: true }))).rejects.toThrow(/запись влита в локальный main, но не отправлена в origin: выполните git push вручную/);
    expect(run(main, "show", "HEAD:mcp-collection/index.json")).toContain("io.example/demo");
  });

  it("canonical comparison: key order and formatting of server.json do not matter", async () => {
    await writeEntry(wt);
    const server = JSON.parse(JSON.stringify({ version: "1.0.0", description: "d", name: "io.example/demo" }));
    await write.accept(wt, SLUG, opts({ server }));
    expect(indexOnMain()).toEqual([{ name: "io.example/demo", version: "1.0.0", path: `mcp-collection/${SLUG}` }]);
  });

  it("parallel reviews: B, forked before A was accepted, still merges and the index keeps both", async () => {
    const wtB = join(dirname(wt), "review-b");
    run(main, "worktree", "add", "-b", "bb/review-b", wtB, "main");
    await writeEntry(wt);
    await write.accept(wt, SLUG, opts({ push: true }));
    await writeEntry(wtB, { name: "io.example/beta", slug: "io-example-beta" });
    await write.accept(wtB, "io-example-beta", opts({ push: true, name: "io.example/beta" }));
    expect(indexOnMain()).toEqual([
      { name: "io.example/demo", version: "1.0.0", path: `mcp-collection/${SLUG}` },
      { name: "io.example/beta", version: "1.0.0", path: "mcp-collection/io-example-beta" },
    ]);
    expect(run(main, "status", "--porcelain").trim()).toBe("");
    expect(run(main, "show", "HEAD:mcp-collection/io-example-demo/review.md")).toBe("ok\n");
    expect(run(main, "show", "HEAD:mcp-collection/io-example-beta/review.md")).toBe("ok\n");
  });

  describe("updates: a newer version replaces this server's line", () => {
    async function acceptV1AndFork(): Promise<string> {
      await writeEntry(wt);
      await write.accept(wt, SLUG, opts({ push: true }));
      const wt2 = join(dirname(wt), "review-v2");
      run(main, "worktree", "add", "-b", "bb/review-v2", wt2, "main");
      return wt2;
    }

    it("accepts a newer version that replaces the line", async () => {
      const wt2 = await acceptV1AndFork();
      await writeEntry(wt2, { version: "1.1.0" });
      expect(await write.branchHasEntry(wt2, SLUG)).toBe(true);
      await write.accept(wt2, SLUG, opts({ version: "1.1.0" }));
      expect(indexOnMain()).toEqual([{ name: "io.example/demo", version: "1.1.0", path: `mcp-collection/${SLUG}` }]);
      expect(JSON.parse(run(main, "show", `HEAD:mcp-collection/${SLUG}/entry.json`)).version).toBe("1.1.0");
    });

    it.each(["1.0.0", "0.9.0"])("refuses version %s, not newer than the accepted one", async (version) => {
      const wt2 = await acceptV1AndFork();
      await writeEntry(wt2, { version });
      const head = run(main, "rev-parse", "HEAD").trim();
      await expect(write.accept(wt2, SLUG, opts({ version }))).rejects.toThrow(/только более новую/);
      expect(run(main, "rev-parse", "HEAD").trim()).toBe(head);
    });

    it("refuses a second line of the same name", async () => {
      const wt2 = await acceptV1AndFork();
      await writeEntry(wt2, { version: "1.1.0", others: [{ name: "io.example/demo", version: "1.0.0", path: `mcp-collection/${SLUG}` }] });
      await expect(write.accept(wt2, SLUG, opts({ version: "1.1.0" }))).rejects.toThrow(/индекс/);
    });
  });
});
