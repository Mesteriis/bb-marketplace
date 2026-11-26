import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLaunchers } from "./launchers";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "launchers-"));
}

async function install(dir: string, name: string, mode = 0o755): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, mode);
  return file;
}

describe("checkLaunchers", () => {
  it("returns ok:false with a Russian message when nothing is found", async () => {
    const empty = await tmp();
    expect(await checkLaunchers("npm", { dirs: [empty] })).toEqual({
      ok: false,
      message: "не найден npx: поставьте Node.js",
    });
    expect(await checkLaunchers("pypi", { dirs: [empty] })).toMatchObject({ ok: false, message: expect.stringContaining("uvx") });
    expect(await checkLaunchers("oci", { dirs: [empty] })).toMatchObject({ ok: false, message: expect.stringContaining("docker") });
  });

  it("finds the launcher in the first directory that has it", async () => {
    const a = await tmp();
    const b = await tmp();
    const file = await install(b, "uvx");
    expect(await checkLaunchers("pypi", { dirs: [a, b] })).toEqual({ ok: true, path: file });
  });

  it("ignores a non-executable file", async () => {
    const a = await tmp();
    await install(a, "docker", 0o644);
    expect((await checkLaunchers("oci", { dirs: [a] })).ok).toBe(false);
  });

  it("searches ~/.local/bin, mise installs and PATH when no dirs are injected", async () => {
    const home = await tmp();
    const empty = await tmp();
    await install(join(home, ".local/bin"), "uvx");
    expect(await checkLaunchers("pypi", { home, path: empty, system: [] })).toMatchObject({ ok: true });
    const mise = await install(join(home, ".local/share/mise/installs/node/22.1.0/bin"), "npx");
    expect(await checkLaunchers("npm", { home, path: empty, system: [] })).toEqual({ ok: true, path: mise });
    const onPathDir = await tmp();
    const onPath = await install(onPathDir, "docker");
    expect(await checkLaunchers("oci", { home, path: `${empty}:${onPathDir}`, system: [] })).toEqual({ ok: true, path: onPath });
  });
});
