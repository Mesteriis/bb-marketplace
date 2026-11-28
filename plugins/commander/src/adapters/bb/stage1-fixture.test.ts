import { runPluginStorageMigrations } from "@get-bb/plugin-sdk/internal/host-policy";
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createSqliteJobStore } from "./job-store-sqlite.ts";
import { MIGRATIONS } from "./migrations.ts";

// The fixture is a database written by the stage-one code at main@b44884df (six migrations, one running job with
// a copying checkpoint). It is opened by the current code with migrations 8 and 9 appended.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "testing/fixtures/stage1-b44884df.sqlite");
const JOB = "123e4567-e89b-42d3-a456-426614174000";

test("stage-one job and checkpoint rows load after migrations 8 and 9, with the stage-one journal untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "commander-fixture-"));
  const file = join(dir, "stage1.sqlite");
  copyFileSync(FIXTURE, file);
  const db = new Database(file);
  try {
    const journal = () => db.prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id").all() as Array<{ id: number; statement_hash: string }>;
    const before = journal();
    expect(before.map((row) => row.id)).toEqual([0, 1, 2, 3, 4, 5]);
    runPluginStorageMigrations(db, MIGRATIONS);
    const after = journal();
    expect(after.map((row) => row.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(after.slice(0, 6)).toEqual(before);

    const store = createSqliteJobStore(db);
    const job = await store.get(JOB);
    expect(job).toMatchObject({
      id: JOB, state: "running", currentItem: 0, awaitsOwner: false,
      plan: { kind: "copy", sourceEndpoint: "host:test", targetEndpoint: "sftp:5b568675-f842-4a96-83e0-78ae53d96024", totalBytes: "3" },
      progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "3" },
    });
    expect(job!.plan.items[0]!.target!.path.segments).toEqual([{ t: "out" }, { t: "a.txt" }]);
    expect(await store.lastCheckpoint(JOB, 0)).toStrictEqual({
      jobId: JOB, itemIndex: 0, phase: "copying", bytesDone: "3",
      tempPath: { segments: [{ t: "out" }, { t: ".commander-x-0.part" }] },
      tempFingerprint: { size: "3", mtimeNs: "5" }, via: "copy",
      targetPath: { segments: [{ t: "out" }, { t: "a.txt" }] }, expectTarget: "absent", verified: null,
    });
    expect(db.prepare("SELECT commit_intent_json FROM checkpoints").pluck().get()).toBeNull();
    expect(db.prepare("SELECT count(*) FROM archives").pluck().get()).toBe(0);
    // The upgraded database takes new checkpoints and a new archive row.
    await store.checkpoint({ ...(await store.lastCheckpoint(JOB, 0))!, commitIntent: { size: "3", sha256: "c".repeat(64), tempFingerprint: { size: "3", mtimeNs: "5" } } });
    expect((await store.lastCheckpoint(JOB, 0))!.commitIntent).toBeDefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
