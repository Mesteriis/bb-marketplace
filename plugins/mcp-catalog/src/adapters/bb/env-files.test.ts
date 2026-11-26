import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EnvFiles } from "./env-files";

let dir: string;
let env: EnvFiles;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "env-files-"));
  env = new EnvFiles(dir);
});

/** Sources the file exactly as run.sh does and prints one variable. */
const sourced = (file: string, key: string, cwd?: string) =>
  execFileSync("/bin/sh", ["-c", `set -a; . "$1"; printf %s "$${key}"`, "sh", file], { encoding: "utf8", cwd });

describe("EnvFiles", () => {
  it("creates the file with mode 0600 in a 0700 directory", async () => {
    await env.write("srv", { TOKEN: "abc" });
    expect(env.path("srv")).toBe(join(dir, "env", "srv.env"));
    expect((await stat(env.path("srv"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "env"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(dir, "env"))).toEqual(["srv.env"]);
  });

  it("keeps the old value when the new one is empty and merges new keys", async () => {
    await env.write("srv", { A: "one", B: "two" });
    await env.write("srv", { A: "", C: "three" });
    expect(sourced(env.path("srv"), "A")).toBe("one");
    expect(sourced(env.path("srv"), "B")).toBe("two");
    expect(sourced(env.path("srv"), "C")).toBe("three");
  });

  it("does not store a key whose value is empty on first write", async () => {
    await env.write("srv", { A: "" });
    expect(await env.state("srv")).toEqual({});
  });

  it("reports set/missing per key", async () => {
    await env.write("srv", { A: "x" });
    expect(await env.state("srv")).toEqual({ A: "set" });
    expect(await env.state("none")).toEqual({});
  });

  it("round-trips a hostile value through sh without running anything", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "env-cwd-"));
    const value = "it's $(touch PWNED) `touch PWNED2` \"q\" \\ line1\nline2 $HOME";
    await env.write("srv", { KEY: value });
    expect(sourced(env.path("srv"), "KEY", cwd)).toBe(value);
    expect(await readdir(cwd)).toEqual([]);
    expect(await readFile(env.path("srv"), "utf8")).toContain("KEY='it'\\''s");
  });

  it("keeps hostile values intact across a later merge", async () => {
    const value = "a'b\nc";
    await env.write("srv", { KEY: value });
    await env.write("srv", { OTHER: "x" });
    expect(sourced(env.path("srv"), "KEY")).toBe(value);
  });

  it("rejects an invalid key name", async () => {
    await expect(env.write("srv", { "A B": "x" })).rejects.toThrow();
  });

  it("refuses to merge into a corrupted file instead of dropping keys", async () => {
    await env.write("srv", { A: "x" });
    await writeFile(env.path("srv"), "A='x'\ngarbage line\n");
    await expect(env.write("srv", { B: "y" })).rejects.toThrow("файл ключей повреждён");
    await expect(env.state("srv")).rejects.toThrow("файл ключей повреждён");
  });

  it("deletes the file and tolerates a missing one", async () => {
    await env.write("srv", { A: "x" });
    await env.remove("srv");
    await env.remove("srv");
    expect(await env.state("srv")).toEqual({});
  });

  it("refuses a bad slug", async () => {
    await expect(env.write("../x", { A: "1" })).rejects.toThrow();
    expect(() => env.path("a/b")).toThrow();
  });

  it("clear deletes only the listed keys, keeps the rest sourceable and the mode 0600", async () => {
    await env.write("srv", { A: "one", B: "two" });
    await env.clear("srv", ["A", "NEVER_SET"]);
    expect(await env.state("srv")).toEqual({ B: "set" });
    expect(sourced(env.path("srv"), "A")).toBe("");
    expect(sourced(env.path("srv"), "B")).toBe("two");
    expect((await stat(env.path("srv"))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "env"))).toEqual(["srv.env"]);
  });

  it("clear leaves an empty sourceable file when every key goes, and tolerates a missing file", async () => {
    await env.write("srv", { A: "one" });
    await env.clear("srv", ["A"]);
    expect(await env.state("srv")).toEqual({});
    expect(sourced(env.path("srv"), "A")).toBe("");
    await env.clear("none", ["A"]);
    expect(await env.state("none")).toEqual({});
  });

  it("clear refuses a bad key name", async () => {
    await expect(env.clear("srv", ["a b"])).rejects.toThrow("недопустимое имя переменной");
  });

  it("serialises writes of the same slug: concurrent updates are not lost", async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `K${i}`);
    await Promise.all(keys.map((key, i) => env.write("srv", { [key]: `v${i}` })));
    expect(Object.keys(await env.state("srv")).sort()).toEqual([...keys].sort());
    expect(await readdir(join(dir, "env"))).toEqual(["srv.env"]);
  });

  it("serialises a write and a clear of the same slug in call order", async () => {
    await env.write("srv", { A: "1", B: "2" });
    await Promise.all([env.write("srv", { C: "3" }), env.clear("srv", ["A"]), env.write("srv", { D: "4" })]);
    expect(await env.state("srv")).toEqual({ B: "set", C: "set", D: "set" });
  });

  it("apply sets new values and removes cleared keys in one replacement", async () => {
    await env.write("srv", { A: "one", B: "two", C: "three" });
    await env.apply("srv", { A: "uno", D: "four", E: "" }, ["B"]);
    expect(await env.state("srv")).toEqual({ A: "set", C: "set", D: "set" });
    expect(sourced(env.path("srv"), "A")).toBe("uno");
    expect(sourced(env.path("srv"), "B")).toBe("");
    expect((await stat(env.path("srv"))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "env"))).toEqual(["srv.env"]);
  });

  it("apply with a bad key changes nothing", async () => {
    await env.write("srv", { A: "one" });
    await expect(env.apply("srv", { B: "x" }, ["a b"])).rejects.toThrow("недопустимое имя переменной");
    await expect(env.apply("srv", { "b c": "x" }, ["A"])).rejects.toThrow("недопустимое имя переменной");
    expect(sourced(env.path("srv"), "A")).toBe("one");
    expect(await env.state("srv")).toEqual({ A: "set" });
  });
});
