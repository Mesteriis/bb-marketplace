import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PackagesDir } from "./packages-dir";

let dir: string;
let packages: PackagesDir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "packages-dir-"));
  packages = new PackagesDir(dir);
});

describe("PackagesDir", () => {
  it("writes the files map, nested, and returns the absolute dir", async () => {
    const out = await packages.write("my-srv", {
      "plugin.json": "{}",
      "bin/run.sh": "#!/bin/sh\n",
      "bin/shim.py": "print(1)\n",
      "README.txt": "hi",
    });
    expect(out).toBe(join(dir, "packages", "my-srv"));
    expect(await readFile(join(out, "plugin.json"), "utf8")).toBe("{}");
    expect((await stat(join(out, "bin/run.sh"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(out, "bin/shim.py"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(out, "README.txt"))).mode & 0o111).toBe(0);
  });

  it("replaces the directory: stale files vanish, no temp siblings remain", async () => {
    await packages.write("srv", { "old.txt": "1", "keep.txt": "1" });
    const out = await packages.write("srv", { "keep.txt": "2" });
    expect(await readdir(out)).toEqual(["keep.txt"]);
    expect(await readdir(join(dir, "packages"))).toEqual(["srv"]);
  });

  it("removes the directory and tolerates a missing one", async () => {
    const out = await packages.write("srv", { "a.txt": "x" });
    await packages.remove("srv");
    await packages.remove("srv");
    await expect(stat(out)).rejects.toThrow();
  });

  it("refuses a bad slug and a file path escaping the package", async () => {
    await expect(packages.write("../evil", { "a": "x" })).rejects.toThrow();
    await expect(packages.write("Bad", { "a": "x" })).rejects.toThrow();
    await expect(packages.remove("a/b")).rejects.toThrow();
    await expect(packages.write("srv", { "../x": "x" })).rejects.toThrow();
    await expect(packages.write("srv", { "/abs": "x" })).rejects.toThrow();
  });

  it("reads back what it wrote, nested, and gives null for a package that is not there", async () => {
    const files = { "plugin.json": "{}", "bin/run.sh": "#!/bin/sh\n", "bin/deep/x.txt": "x" };
    await packages.write("my-srv", files);
    expect(await packages.read("my-srv")).toEqual(files);
    expect(await packages.read("other")).toBeNull();
  });
});
