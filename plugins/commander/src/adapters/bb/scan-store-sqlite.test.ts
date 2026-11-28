import Database from "better-sqlite3";
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { runPluginStorageMigrations } from "@get-bb/plugin-sdk/internal/host-policy";
import { expect, test } from "vitest";
import activate from "../../../server.ts";
import type { OperationJob } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import { createSqliteJobStore } from "./job-store-sqlite.ts";
import { MIGRATIONS } from "./migrations.ts";

test("restart marks a running scan interrupted and preserves its byte count", async () => {
  const db = new Database(":memory:");
  try {
    for (const sql of MIGRATIONS) db.exec(sql);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").pluck().get("scan_jobs")).toBe("scan_jobs");
    const { createSqliteScanStore } = await import("./scan-store-sqlite.ts");
    const first = createSqliteScanStore(db);
    const id = "223e4567-e89b-42d3-a456-426614174000";
    first.save({
      id, kind: "checksum", state: "running", initiator: { kind: "owner" }, endpoints: ["host:test"],
      progress: { items: 0, bytes: 9007199254740993n, bytesPlanned: 9007199254740994n }, partial: false, error: null,
    });
    const restarted = createSqliteScanStore(db);
    restarted.interruptRunning();
    expect(restarted.get(id)).toMatchObject({ state: "interrupted", partial: true,
      progress: { items: 0, bytes: 9007199254740993n, bytesPlanned: 9007199254740994n } });
  } finally { db.close(); }
});

test("agent without read on the right endpoint gets the same refusal text as planner tools", async () => {
  const db = new Database(":memory:");
  const kv = new Map<string, unknown>([["agent-grants", [{
    threadId: "thread-test", endpoint: "host:left", scope: parsePosix("/"), permissions: ["read"],
  }]]]);
  const tools = new Map<string, (input: unknown, ctx: PluginAgentToolContext) => unknown>();
  const dispose: (() => Promise<void>)[] = [];
  try {
    activate({
      storage: {
        database: () => db,
        migrate: (_db: Database.Database, statements: string[]) => statements.forEach((sql) => db.exec(sql)),
        kv: { get: async (key: string) => kv.get(key) },
      },
      hosts: { experimental_client: () => ({}) },
      rpc: { register: () => {} },
      cli: { register: () => {} },
      background: { service: () => {} },
      onDispose: (hook: () => Promise<void>) => dispose.push(hook),
      agents: { registerTool: (tool: { name: string; execute: (input: unknown, ctx: PluginAgentToolContext) => unknown }) =>
        tools.set(tool.name, tool.execute) },
    } as unknown as BbPluginApi);
    const result = await tools.get("commander_compare")?.({
      kind: "files", left: { endpoint: "host:left", path: parsePosix("/a") },
      right: { endpoint: "host:right", path: parsePosix("/a") }, mode: "size",
    }, { threadId: "thread-test", projectId: "project", signal: new AbortController().signal });
    expect(result).toMatchObject({ isError: true,
      content: [{ type: "text", text: '{"code":"forbidden","message":"Commander refused the request"}' }] });
  } finally {
    try { for (const hook of dispose) await hook(); }
    finally { db.close(); }
  }
});

test("migrates six stage-one migrations without changing the saved transfer job", async () => {
  const db = new Database(":memory:");
  const date = "2026-11-27T00:00:00.000Z";
  const targetDir = { endpoint: "host:test", path: parsePosix("/") };
  const job: OperationJob = {
    id: "223e4567-e89b-42d3-a456-426614174000",
    plan: {
      id: "123e4567-e89b-42d3-a456-426614174000", kind: "copy", initiator: { kind: "owner" },
      createdAt: date, sourceEndpoint: "host:test", targetEndpoint: "host:test", targetDir,
      route: "same-endpoint", verify: "size", conflictPolicy: "ask", totalBytes: "3",
      digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      items: [{
        source: { endpoint: "host:test", path: parsePosix("/data/a") },
        target: { endpoint: "host:test", path: parsePosix("/a") },
        kind: "file", fingerprint: { size: "3", mtimeNs: "100" }, expectTarget: "absent",
      }],
    },
    state: "pending", currentItem: null, pendingConflict: null, awaitsOwner: false, error: null,
    progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "3" },
    items: [{ outcome: "pending", error: null }], createdAt: date, updatedAt: date,
  };

  try {
    runPluginStorageMigrations(db, MIGRATIONS.slice(0, 6));
    const journal = db.prepare("SELECT id FROM _bb_migrations ORDER BY id").pluck();
    expect(journal.all()).toEqual([0, 1, 2, 3, 4, 5]);
    await createSqliteJobStore(db).create(job);
    runPluginStorageMigrations(db, MIGRATIONS);
    expect(journal.all()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await expect(createSqliteJobStore(db).get(job.id)).resolves.toStrictEqual(job);
    expect(db.prepare("SELECT count(*) FROM scan_jobs").pluck().get()).toBe(0);
  } finally { db.close(); }
});
