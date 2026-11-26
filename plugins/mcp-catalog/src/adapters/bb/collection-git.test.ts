import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CollectionGit } from "./collection-git";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

let origin: string;
let work: string;
let clone: string;

async function commitToOrigin(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), text);
  }
  run(work, "add", "-A");
  run(work, "commit", "-m", "c");
  run(work, "push", "origin", "main");
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-git-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  clone = join(root, "clone");
  run(root, "init", "--bare", "-b", "main", origin);
  run(root, "clone", origin, work);
  run(work, "checkout", "-b", "main");
  await commitToOrigin({ "README.md": "x" });
  run(root, "clone", origin, clone);
});

describe("CollectionGit", () => {
  it("treats a missing index on origin/main as an empty collection", async () => {
    expect(await new CollectionGit(clone).readIndex()).toEqual({ servers: [] });
  });

  it("fetches before reading: sees commits pushed after the clone, not the working tree", async () => {
    const index = { servers: [{ name: "a/b", version: "1.0.0", path: "mcp-collection/a-b" }] };
    await commitToOrigin({ "mcp-collection/index.json": JSON.stringify(index), "mcp-collection/a-b/entry.json": "{}" });
    await writeFile(join(clone, "local.txt"), "unpushed");
    const port = new CollectionGit(clone);
    expect(await port.readIndex()).toEqual(index);
    expect(await port.readFile("mcp-collection/a-b/entry.json")).toBe("{}");
  });

  it("refuses paths outside mcp-collection/ or with ..", async () => {
    const port = new CollectionGit(clone);
    await expect(port.readFile("README.md")).rejects.toThrow("недопустимый путь");
    await expect(port.readFile("mcp-collection/../README.md")).rejects.toThrow("недопустимый путь");
    await expect(port.readFile("mcp-collection-evil/x")).rejects.toThrow("недопустимый путь");
  });

  it("reports a missing file as an error", async () => {
    await expect(new CollectionGit(clone).readFile("mcp-collection/none/entry.json")).rejects.toThrow();
  });

  it("propagates fetch failures instead of returning an empty collection", async () => {
    run(clone, "remote", "set-url", "origin", join(clone, "nowhere"));
    await expect(new CollectionGit(clone).readIndex()).rejects.toThrow();
  });

  it("shares one fetch between concurrent reads and reuses it for the ttl, until invalidated", async () => {
    let now = 1_000;
    const port = new CollectionGit(clone, 10_000, () => now);
    const index = { servers: [{ name: "a/b", version: "1.0.0", path: "mcp-collection/a-b" }] };
    const [first, second] = await Promise.all([port.readIndex(), port.readIndex()]);
    expect(first).toEqual({ servers: [] });
    expect(second).toEqual({ servers: [] });
    await commitToOrigin({ "mcp-collection/index.json": JSON.stringify(index) });
    now += 5_000;
    expect(await port.readIndex()).toEqual({ servers: [] }); // within the ttl: no new fetch
    now += 6_000;
    expect(await port.readIndex()).toEqual(index); // ttl over: fetched again
    await commitToOrigin({ "mcp-collection/index.json": JSON.stringify({ servers: [] }) });
    expect(await port.readIndex()).toEqual(index); // cached again
    port.invalidate();
    expect(await port.readIndex()).toEqual({ servers: [] });
  });

  it("does not cache a failed fetch", async () => {
    const port = new CollectionGit(clone, 10_000, () => 1);
    run(clone, "remote", "set-url", "origin", join(clone, "nowhere"));
    await expect(port.readIndex()).rejects.toThrow();
    run(clone, "remote", "set-url", "origin", origin);
    expect(await port.readIndex()).toEqual({ servers: [] });
  });

  it("isAccepted: true only for a commit that is an ancestor of origin/main", async () => {
    await commitToOrigin({ "mcp-collection/index.json": '{"servers":[]}' });
    const onMain = run(work, "rev-parse", "HEAD").trim();
    run(work, "checkout", "-b", "side");
    await mkdir(join(work, "s"), { recursive: true });
    await writeFile(join(work, "s", "f"), "1");
    run(work, "add", "-A");
    run(work, "commit", "-m", "side");
    const side = run(work, "rev-parse", "HEAD").trim();
    run(work, "push", "origin", "side");
    const port = new CollectionGit(clone);
    expect(await port.isAccepted(onMain)).toBe(true);
    expect(await port.isAccepted(side)).toBe(false);
    expect(await port.isAccepted("0".repeat(40))).toBe(false);
    expect(await port.isAccepted("--all")).toBe(false);
    expect(await port.isAccepted("main")).toBe(false);
  });

  describe("fetch coalescing", () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    /** A git runner whose fetches stay pending until released; everything else answers an empty index. */
    function gatedRunner() {
      const gates: (() => void)[] = [];
      let fetches = 0;
      const runner = (_repo: string, args: string[]): Promise<string> => {
        if (args[0] !== "fetch") return Promise.resolve('{"servers":[]}');
        fetches++;
        return new Promise((resolve) => gates.push(() => resolve("")));
      };
      return { runner, gates, fetches: () => fetches };
    }

    it("keeps one fetch in flight; invalidations during it schedule exactly one follow-up", async () => {
      const gated = gatedRunner();
      const port = new CollectionGit("/repo", 10_000, () => 1, gated.runner);
      const first = port.readIndex();
      await tick();
      port.invalidate();
      const second = port.readIndex();
      port.invalidate();
      const third = port.readIndex();
      await tick();
      expect(gated.fetches()).toBe(1);
      gated.gates[0]?.();
      await tick();
      expect(gated.fetches()).toBe(2);
      gated.gates[1]?.();
      expect(await Promise.all([first, second, third])).toEqual([{ servers: [] }, { servers: [] }, { servers: [] }]);
      expect(gated.fetches()).toBe(2);
    });

    it("an invalidate during a fetch that nobody reads is not lost: the next read fetches again", async () => {
      const gated = gatedRunner();
      const port = new CollectionGit("/repo", 10_000, () => 1, gated.runner);
      const first = port.readIndex();
      await tick();
      port.invalidate();
      gated.gates[0]?.();
      await first;
      await tick();
      const second = port.readIndex();
      await tick();
      expect(gated.fetches()).toBe(2);
      gated.gates[1]?.();
      await second;
    });

    it("an invalidate with nothing in flight just makes the next read fetch again", async () => {
      const gated = gatedRunner();
      const port = new CollectionGit("/repo", 10_000, () => 1, gated.runner);
      const first = port.readIndex();
      await tick();
      gated.gates[0]?.();
      await first;
      port.invalidate();
      const second = port.readIndex();
      await tick();
      expect(gated.fetches()).toBe(2);
      gated.gates[1]?.();
      await second;
    });
  });
});

describe("CollectionGit.sameEntryAt", () => {
  const dir = "mcp-collection/a-b";
  it("is true while the folder is unchanged on origin/main, false after it changed, and false for bad input", async () => {
    await commitToOrigin({ [`${dir}/entry.json`]: "1", "mcp-collection/index.json": '{"servers":[]}' });
    const accepted = run(work, "rev-parse", "HEAD").trim();
    await commitToOrigin({ "mcp-collection/index.json": '{"servers":[1]}' });
    const port = new CollectionGit(clone, 0);
    expect(await port.sameEntryAt(accepted, dir)).toBe(true);
    await commitToOrigin({ [`${dir}/entry.json`]: "2" });
    expect(await port.sameEntryAt(accepted, dir)).toBe(false);
    expect(await port.sameEntryAt("0".repeat(40), dir)).toBe(false);
    expect(await port.sameEntryAt("HEAD", dir)).toBe(false);
    expect(await port.sameEntryAt(accepted, "README.md")).toBe(false);
    expect(await port.sameEntryAt(accepted, "mcp-collection/../README.md")).toBe(false);
    expect(await port.sameEntryAt(accepted, "mcp-collection/none")).toBe(false);
  });
});
