import { describe, expect, it } from "vitest";
import { clampDepth, expandRoot, scanRepos, settingsList, type ScanFs } from "./repo-scan.ts";

/** An in-memory tree: keys ending in "/" are directories, others files with their text. */
function memoryFs(entries: Record<string, string>, unreadable: string[] = []): ScanFs {
  const dirs = new Set<string>();
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(entries)) {
    if (path.endsWith("/")) dirs.add(path.slice(0, -1));
    else files.set(path, text);
    const parts = path.replace(/\/$/, "").split("/");
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    async list(dir) {
      if (unreadable.includes(dir) || !dirs.has(dir)) throw new Error(`ENOENT ${dir}`);
      const names = new Map<string, "dir" | "file">();
      for (const d of dirs) if (d.startsWith(dir + "/") && !d.slice(dir.length + 1).includes("/")) names.set(d.slice(dir.length + 1), "dir");
      for (const f of files.keys()) if (f.startsWith(dir + "/") && !f.slice(dir.length + 1).includes("/")) names.set(f.slice(dir.length + 1), "file");
      return [...names].map(([name, kind]) => ({ name, kind }));
    },
    async read(path) {
      return files.get(path) ?? null;
    },
  };
}

const ORIGIN = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;

describe("scanRepos", () => {
  it("finds repositories whose .git sits within the depth, like find -maxdepth", async () => {
    const fs = memoryFs({
      "/p/a/.git/config": ORIGIN("git@github.com:me/a.git"),
      "/p/group/b/.git/config": "[core]\n",
      "/p/x/y/c/.git/config": "",
      "/p/x/y/z/d/.git/config": "",
    });
    const r = await scanRepos(fs, ["/p"], 4);
    expect(r.repos.map((x) => x.path)).toEqual(["/p/a", "/p/group/b", "/p/x/y/c"]);
    expect(r.roots).toEqual([{ root: "/p", ok: true }]);
  });

  it("reads remotes and their forge keys", async () => {
    const fs = memoryFs({ "/p/a/.git/config": ORIGIN("git@github.com:Me/A.git") });
    const r = await scanRepos(fs, ["/p"], 4);
    expect(r.repos).toEqual([{ path: "/p/a", name: "a", root: "/p", remotes: ["git@github.com:Me/A.git"], keys: ["github.com/me/a"] }]);
  });

  it("keeps nested repositories and skips node_modules and .git contents", async () => {
    const fs = memoryFs({
      "/p/outer/.git/config": "",
      "/p/outer/inner/.git/config": "",
      "/p/outer/node_modules/pkg/.git/config": "",
      "/p/outer/.git/modules/m/.git/config": "",
    });
    const r = await scanRepos(fs, ["/p"], 4);
    expect(r.repos.map((x) => x.path)).toEqual(["/p/outer", "/p/outer/inner"]);
  });

  it("reads the remote of a worktree through gitdir and commondir", async () => {
    const fs = memoryFs({
      "/p/main/.git/config": ORIGIN("https://github.com/me/main.git"),
      "/p/main/.git/worktrees/feat/commondir": "../..\n",
      "/p/feat/.git": "gitdir: ../main/.git/worktrees/feat\n",
    });
    const r = await scanRepos(fs, ["/p"], 4);
    const feat = r.repos.find((x) => x.path === "/p/feat");
    expect(feat?.keys).toEqual(["github.com/me/main"]);
  });

  it("reports a root it cannot read and still scans the others", async () => {
    const fs = memoryFs({ "/q/a/.git/config": "" });
    const r = await scanRepos(fs, ["/missing", "/q/"], 4);
    expect(r.roots).toEqual([
      { root: "/missing", ok: false },
      { root: "/q", ok: true },
    ]);
    expect(r.repos.map((x) => x.path)).toEqual(["/q/a"]);
  });

  it("does not list the same repository twice for overlapping roots", async () => {
    const fs = memoryFs({ "/p/sub/a/.git/config": "" });
    const r = await scanRepos(fs, ["/p", "/p/sub"], 4);
    expect(r.repos.map((x) => x.path)).toEqual(["/p/sub/a"]);
  });

  it("skips an unreadable folder below a root", async () => {
    const fs = memoryFs({ "/p/a/.git/config": "", "/p/locked/b/.git/config": "" }, ["/p/locked"]);
    const r = await scanRepos(fs, ["/p"], 4);
    expect(r.repos.map((x) => x.path)).toEqual(["/p/a"]);
    expect(r.roots).toEqual([{ root: "/p", ok: true }]);
  });

  it("stops at the repository limit", async () => {
    const fs = memoryFs({ "/p/a/.git/config": "", "/p/b/.git/config": "", "/p/c/.git/config": "" });
    const r = await scanRepos(fs, ["/p"], 4, { limit: 2 });
    expect(r.repos.map((x) => x.path)).toEqual(["/p/a", "/p/b"]);
    expect(r.truncated).toBe(true);
  });
});

describe("expandRoot", () => {
  it.each([
    ["~/projects", "/Users/me/projects"],
    ["~", "/Users/me"],
    ["/srv/code/", "/srv/code"],
    ["  ~/a  ", "/Users/me/a"],
  ])("expands %j", (root, out) => {
    expect(expandRoot(root, "/Users/me")).toBe(out);
  });

  it.each(["", "relative/dir", "~other/x"])("refuses %j", (root) => {
    expect(expandRoot(root, "/Users/me")).toBeNull();
  });
});

describe("settingsList", () => {
  it("splits on commas and new lines, trims and drops duplicates", () => {
    expect(settingsList(" ~/projects,\n/srv/code \n\n~/projects , ")).toEqual(["~/projects", "/srv/code"]);
  });

  it("is empty for an empty setting", () => {
    expect(settingsList("  \n ")).toEqual([]);
  });
});

describe("clampDepth", () => {
  it.each([
    [4, 4],
    [0, 1],
    [12, 8],
    [2.7, 2],
    [Number.NaN, 4],
  ])("turns %d into %d", (v, out) => {
    expect(clampDepth(v)).toBe(out);
  });
});
