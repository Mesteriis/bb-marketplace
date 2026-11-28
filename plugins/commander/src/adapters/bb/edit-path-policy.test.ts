import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parsePosix } from "../../core/path.ts";
import { createEditPathPolicy } from "./edit-path-policy.ts";

let data: string;
let root: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  data = await realpath(await mkdtemp(join(tmpdir(), "commander-path-policy-")));
  root = join(data, "commander-edits");
  await mkdir(root);
  await writeFile(join(root, "sample"), "secret");
  await writeFile(join(data, "public"), "visible");
});
afterEach(async () => { await rm(data, { recursive: true, force: true }); });

it("refuses the private tree, including nonexistent descendants", async () => {
  const policy = await createEditPathPolicy(data, "posix", signal);
  for (const path of [root, join(root, "sample"), join(root, "new")]) {
    await expect(policy.check(parsePosix(path))).rejects.toMatchObject({ code: "permission_denied" });
  }
  await expect(policy.check(parsePosix(join(data, "public")))).resolves.toBeUndefined();
});

it("protects a lookup through a symlink pointing into the private tree", async () => {
  const alias = join(data, "alias");
  await symlink(root, alias);
  const policy = await createEditPathPolicy(data, "posix", signal);
  await expect(policy.check(parsePosix(join(alias, "sample")))).rejects.toMatchObject({ code: "permission_denied" });
  await expect(policy.hidden(Buffer.from(alias))).resolves.toBe(true);
});

it("refuses an alias of the data directory, including /var on macOS", async () => {
  const alias = join(data, "outer-alias");
  await symlink(data, alias);
  const policy = await createEditPathPolicy(data, "posix", signal);
  await expect(policy.check(parsePosix(join(alias, "commander-edits", "sample"))))
    .rejects.toMatchObject({ code: "permission_denied" });
  if (data.startsWith("/private/var/")) {
    await expect(policy.check(parsePosix(join(data.slice(8), "commander-edits", "sample"))))
      .rejects.toMatchObject({ code: "permission_denied" });
  }
});

it("reserves case variants and hides any direct reference under the parent before opening a session", async () => {
  await rm(root, { recursive: true });
  const policy = await createEditPathPolicy(data, "posix", signal);
  await expect(policy.check(parsePosix(join(data, "COMMANDER-EDITS")))).rejects.toMatchObject({ code: "permission_denied" });
  await expect(policy.hidden(Buffer.from(join(data, "public")))).resolves.toBe(false);
});

it("disallows rename or removal of an ancestor while permitting directory traversal", async () => {
  const policy = await createEditPathPolicy(data, "posix", signal);
  await expect(policy.check(parsePosix(data))).resolves.toBeUndefined();
  await expect(policy.check(parsePosix(data), true)).rejects.toMatchObject({ code: "permission_denied" });
});

it("filters the private directory in host listing and blocks direct reads", async () => {
  const { createHostFs } = await import("./host-fs/index.ts");
  const fs = createHostFs();
  const context = { signal, experimental_paths: { dataDir: data } };
  const page = await fs.handlers.list({ path: parsePosix(data), cursor: null, limit: 1 }, context);
  expect(page.entries.map(({ name }) => name)).toEqual([{ t: "public" }]);
  expect(page.cursor).toBeNull();
  await expect(fs.handlers.read({
    path: parsePosix(join(root, "sample")), offset: "0", length: 10, expect: null,
  }, context)).rejects.toMatchObject({
    code: "permission_denied", message: "Path is outside the agent's grant",
  });
  await fs.dispose();
});
