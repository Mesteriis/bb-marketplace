import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createEditFiles } from "./edit-files.ts";

const id = "65fb3d47-752e-48d8-b4c4-7112e2e4f460";
const second = "3eba1fbe-3842-4081-b33b-8ec4dae644ba";
const snapshotId = "0ab5206e-f7bd-41b2-ac5a-520ddf705965";
const abc = Buffer.from("abc");
const changed = Buffer.from("xyz");
let dir: string;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "commander-edit-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("publishes a revision only when its final digest matches", async () => {
  const files = createEditFiles();
  await files.create(dir, id);
  await files.writeChunk(dir, id, 0, 0, abc);
  await expect(files.commitRevision(dir, id, 0, "0".repeat(64))).rejects.toThrow("SHA-256");
  await files.writeChunk(dir, id, 0, 0, abc.subarray(0, 1));
  await files.writeChunk(dir, id, 0, 1, abc.subarray(1));
  await expect(files.commitRevision(dir, id, 0, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
    .resolves.toBe(1);
  expect(await files.readChunk(dir, id, { revision: 1 }, 1, 2)).toEqual({ bytes: "YmM=", eof: true });
});

it("keeps a snapshot immutable while another revision is saved", async () => {
  const files = createEditFiles();
  await files.create(dir, id);
  await files.writeChunk(dir, id, 0, 0, abc);
  await files.commitRevision(dir, id, 0, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const proof = await files.snapshot(dir, id, 1, snapshotId);
  await files.writeChunk(dir, id, 1, 0, changed);
  await files.commitRevision(dir, id, 1, "3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282");
  expect(proof).toMatchObject({ size: "3", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  expect(await files.readChunk(dir, id, { snapshotId }, 0, 3)).toEqual({ bytes: "YWJj", eof: true });
  expect(await files.readChunk(dir, id, { revision: 2 }, 0, 3)).toEqual({ bytes: "eHl6", eof: true });
});

it("does not publish an over-quota save and serializes competing reservations", async () => {
  const files = createEditFiles({ quotaBytes: 5 });
  await files.create(dir, id);
  await files.create(dir, second);
  const writes = await Promise.allSettled([
    files.writeChunk(dir, id, 0, 0, abc),
    files.writeChunk(dir, second, 0, 0, changed),
  ]);
  expect(writes.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
  await files.commitRevision(dir, id, 0, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  await expect(files.writeChunk(dir, id, 1, 0, changed)).rejects.toThrow("1 ГиБ");
  expect(await files.readChunk(dir, id, { revision: 1 }, 0, 3)).toEqual({ bytes: "YWJj", eof: true });
  await expect(files.snapshot(dir, id, 1, snapshotId)).rejects.toThrow("1 ГиБ");
});

it("refuses a symlink at the revision leaf without reading its target", async () => {
  const files = createEditFiles();
  const route = await files.create(dir, id);
  await rm(route);
  const foreign = join(dir, "foreign");
  await writeFile(foreign, "private");
  await symlink(foreign, route);
  await expect(files.readChunk(dir, id, { revision: 0 }, 0, 10)).rejects.toThrow();
  expect(await readFile(foreign, "utf8")).toBe("private");
});

it("resumes a partial load and releases quota after ten minutes of inactivity", async () => {
  let now = 1;
  const files = createEditFiles({ quotaBytes: 5, now: () => now });
  await files.create(dir, id);
  await files.writeChunk(dir, id, 0, 0, abc.subarray(0, 1));
  await files.writeChunk(dir, id, 0, 1, abc.subarray(1));
  expect(await files.readChunk(dir, id, { revision: 0 }, 0, 3)).toEqual({ bytes: "", eof: true });
  now = 600_001;
  await files.discardStaleUpload(dir, id);
  await expect(files.writeChunk(dir, id, 0, 3, abc)).rejects.toThrow("смещение");
  await files.writeChunk(dir, id, 0, 0, changed);
  expect(await files.commitRevision(dir, id, 0, "3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282"))
    .toBe(1);
});

it.each(["draft:2.txt", "notes?.txt"])("uses an existing valid Windows path for SFTP name %s", async (name) => {
  const files = createEditFiles({ platform: "win32" });
  await files.create(dir, id);
  await files.writeChunk(dir, id, 0, 0, abc);
  await files.commitRevision(dir, id, 0, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", true);
  const path = await files.route(dir, id, 0, name);
  expect(path).toBe(join(dir, "commander-edits", id, "revision-0"));
  expect(await readFile(path, "utf8")).toBe("abc");
});
