import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_PluginRpcCallError, type BbPluginApi } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import activate from "../../../server.ts";
import worker from "../../../host.ts";
import { EDIT_SNAPSHOT_ENDPOINT, type WriteBackRequest } from "../../core/edit-session.ts";
import { parsePosix, type NameSegment } from "../../core/path.ts";
import { OperationJob } from "../../core/model.ts";
import { editRpcSchemas } from "../../core/wire/edit.ts";
import { EDIT_DIRECTORY } from "./edit-files.ts";
import { RemoteHubMock } from "./testing/remote-hub-mock.ts";
import { SFTP_REFUSALS, SftpRefusal, type SftpMethodName } from "../../core/wire/remote-hub-sftp.ts";

const client = { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal };
const expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
let folder: string;
let privateData: string;
let source: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), "commander-edit-integration-")));
  privateData = join(folder, "plugin-data");
  await mkdir(privateData);
  source = join(folder, "a.txt");
  await writeFile(source, "abc");
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await rm(folder, { recursive: true, force: true });
});

function ref(path = source) {
  return { endpoint: "host:test", path: parsePosix(path) };
}

async function start(remote = new RemoteHubMock(), primaryHostId: string | null = "test", holdSnapshotRead = false, options: { loseChunkReply?: boolean; caseSensitive?: boolean; identity?: (path: ReturnType<typeof parsePosix>) => { dev: string; ino: string; parentDev: string; parentIno: string; name: NameSegment } } = {}) {
  const db = new Database(join(folder, "jobs.db"));
  const signal = new AbortController();
  const callbacks: (() => Promise<void>)[] = [];
  const kv = new Map<string, unknown>();
  const tools = new Map<string, (input: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>>();
  type Call = (input: unknown, context: unknown) => Promise<unknown>;
  let handlers: Record<string, Call> = {};
  let background: Promise<void> | undefined;
  let sweepStarted = false;
  const snapshotRead = Promise.withResolvers<void>();
  const handlersOfWorker = worker.handlers as Record<string, Call>;
  activate({
    storage: {
      database: () => db,
      migrate: (_db: unknown, migrations: string[]) => {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'jobs'").get()) {
          for (const migration of migrations) db.exec(migration);
        }
      },
      kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { kv.set(key, value); } },
    },
    sdk: {
      system: { config: async () => ({ primaryHostId }) },
      hosts: { list: async () => [{ id: "test", name: "Test" }] },
      plugins: { callRpc: ({ method, input, signal }: { method: SftpMethodName; input: never; signal: AbortSignal }) =>
        method === "hub_sftp_profiles" ? Promise.resolve({ profiles: [{
          id: "5b568675-f842-4a96-83e0-78ae53d96024", name: "Fixture", group: null,
          host: "fixture.invalid", port: 22, user: null, authType: "agent",
          consent: "granted", level: "write", hostKey: "trusted", needsConfig: false,
        }] }) : remote.call(method, input, signal).then((result) =>
          "op" in result && result.op === "realpath" ? { op: "realpath", path: { text: "/" } } : result).catch((error) => {
            if (error instanceof SftpRefusal) {
              throw new experimental_PluginRpcCallError({ code: SFTP_REFUSALS[error.code], message: error.message });
            }
            throw error;
          }) },
    },
    hosts: {
      experimental_client: () => ({
        async call(method: string, data: unknown, ctx: { signal?: AbortSignal }) {
          if (method === "home") return { path: parsePosix(folder), caseSensitive: options.caseSensitive ?? true };
          if (method === "editSweep") sweepStarted = true;
          if (method === "editSourceIdentity" && options.identity) {
            return options.identity((data as { path: ReturnType<typeof parsePosix> }).path);
          }
          if (holdSnapshotRead && method === "editReadChunk" && "snapshotId" in (data as { source: object }).source) {
            snapshotRead.resolve();
            const callSignal = ctx.signal ?? signal.signal;
            callSignal.throwIfAborted();
            await new Promise<never>((_, reject) => callSignal.addEventListener("abort", () => reject(callSignal.reason), { once: true }));
          }
          const result = await handlersOfWorker[method]!(data, { signal: ctx.signal ?? signal.signal, experimental_paths: { dataDir: privateData } });
          if (options.loseChunkReply && method === "editWriteChunk") throw new Error("Host response lost");
          return result;
        },
      }),
    },
    background: { service: (_name: string, entry: { start(signal: AbortSignal): Promise<void> }) => {
      background = entry.start(signal.signal);
      void background.catch(() => {});
    } },
    onDispose: (callback: () => Promise<void>) => callbacks.push(callback),
    log: { error() {} },
    realtime: { publish() {} },
    rpc: { register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; } },
    agents: { registerTool: (item: { name: string; execute: (input: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> }) =>
      tools.set(item.name, item.execute) },
    cli: { register() {} },
  } as unknown as BbPluginApi);
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    signal.abort();
    for (const callback of callbacks) await callback();
    await background;
    db.close();
  }
  cleanups.push(close);
  if (primaryHostId) await expect.poll(() => sweepStarted).toBe(true);
  else await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    close, db, tools, snapshotRead: snapshotRead.promise,
    async tool(name: string, input: unknown) {
      const reply = await tools.get("commander_" + name)!(input, {
        threadId: "thread-edit", signal: signal.signal,
      });
      return JSON.parse(reply.content[0]!.text);
    },
    rpc: (name: string, input: unknown, context: unknown = client) => handlers[name]!(input, context),
    async open() {
      return editRpcSchemas.edit_open.output.parse(await handlers.edit_open!({ ref: ref() }, client));
    },
    async save(sessionId: string, baseRevision: number, text = "hello", sha256 = expected) {
      return handlers.edit_save!({ sessionId, baseRevision, offset: 0, bytes: Buffer.from(text).toString("base64"), final: true, sha256 }, client);
    },
    async completed(jobId: string) {
      await expect.poll(async () => OperationJob.parse(await handlers.job_get!({ jobId }, client)).state).toBe("completed");
      return OperationJob.parse(await handlers.job_get!({ jobId }, client));
    },
  };
}

it("queues an immutable copy, recovers a lost reply, and advances the SFTP-independent local base", async () => {
  let bb = await start();
  const opened = await bb.open();
  expect((await bb.open()).sessionId).toBe(opened.sessionId);
  expect(opened.base).toMatchObject({
    size: "3", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  await expect(bb.save(opened.sessionId, 0)).resolves.toEqual({ revision: 1 });
  const request = { sessionId: opened.sessionId, revision: 1, clientRequestId: randomUUID() };
  const result = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", request));
  if (result.kind !== "written") throw new Error("Expected queued write");
  const job = await bb.completed(result.jobId);
  expect(job.plan.items[0]).toMatchObject({
    source: { endpoint: EDIT_SNAPSHOT_ENDPOINT },
    expectTarget: { size: "3", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  });
  expect(await readFile(source, "utf8")).toBe("hello");
  await bb.close();
  bb = await start();
  await expect(bb.rpc("edit_writeback", request)).resolves.toEqual(result);
  await expect(bb.rpc("edit_writeback", { ...request, revision: 0 })).rejects.toMatchObject({ code: "conflict" });
  expect(bb.db.prepare("SELECT count(*) AS total FROM jobs").get()).toEqual({ total: 1 });
  const info = editRpcSchemas.edit_get.output.parse(await bb.rpc("edit_get", { sessionId: opened.sessionId }));
  expect(info.base).toMatchObject({ size: "5", sha256: expected });
  await expect(bb.rpc("edit_writeback", { ...request, clientRequestId: randomUUID() })).resolves.toMatchObject({ kind: "written" });
});

it("rolls back a job when the receipt write aborts the transaction", async () => {
  const bb = await start();
  const { sessionId } = await bb.open();
  bb.db.exec("CREATE TRIGGER stop_receipt BEFORE INSERT ON edit_writebacks BEGIN SELECT RAISE(ABORT, 'stop'); END");
  const request = { sessionId, revision: 0, clientRequestId: randomUUID() };
  await expect(bb.rpc("edit_writeback", request)).rejects.toMatchObject({ code: "invalid" });
  expect(bb.db.prepare("SELECT count(*) AS total FROM jobs").get()).toEqual({ total: 0 });
  expect(bb.db.prepare("SELECT count(*) AS total FROM edit_writebacks").get()).toEqual({ total: 0 });
  expect(await readFile(source, "utf8")).toBe("abc");
  bb.db.exec("DROP TRIGGER stop_receipt");
  await expect(bb.rpc("edit_writeback", request)).resolves.toMatchObject({ kind: "written" });
});

it("protects a newer copy from a prior conflict choice and saves under the next free name", async () => {
  const bb = await start();
  const { sessionId } = await bb.open();
  await bb.save(sessionId, 0);
  await writeFile(source, "foreign");
  const request: WriteBackRequest = { sessionId, revision: 1, clientRequestId: randomUUID() };
  const conflict = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", request));
  if (conflict.kind !== "conflict") throw new Error("Expected conflict");
  expect(conflict).toMatchObject({ reason: "changed", revision: 1, current: { size: "7" } });
  await bb.save(sessionId, 1, "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const stale = await bb.rpc("edit_writeback", { ...request, choice: "overwrite", conflictId: conflict.conflictId });
  const fresh = editRpcSchemas.edit_writeback.output.parse(stale);
  if (fresh.kind !== "conflict") throw new Error("Expected fresh conflict");
  expect(fresh).toMatchObject({ revision: 2, reason: "changed" });
  expect(fresh.conflictId).not.toBe(conflict.conflictId);
  expect(await readFile(source, "utf8")).toBe("foreign");
  await writeFile(join(folder, "a (2).txt"), "occupied");
  const result = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", {
    ...request, revision: 2, choice: "save-beside", conflictId: fresh.conflictId,
  }));
  if (result.kind !== "written") throw new Error("Expected queued write");
  const job = await bb.completed(result.jobId);
  expect(job.plan.items[0]?.expectTarget).toBe("absent");
  expect(await readFile(join(folder, "a (3).txt"), "utf8")).toBe("abc");
  expect(await readFile(join(folder, "a (2).txt"), "utf8")).toBe("occupied");
  expect(await readFile(source, "utf8")).toBe("foreign");
});

it("hides copies from panel and refuses editor methods for agents and plugins with a session id", async () => {
  const bb = await start();
  const { sessionId, opener } = await bb.open();
  const params = { sessionId };
  for (const kind of ["agent", "plugin"]) {
    const context = { ...client, experimental_caller: { kind } };
    for (const method of ["edit_get", "edit_read", "edit_save", "edit_writeback", "edit_close"]) {
      await expect(bb.rpc(method, params, context)).rejects.toMatchObject({ code: "forbidden" });
    }
  }
  expect([...bb.tools.keys()].filter((name) => name.includes("edit"))).toEqual([]);
  await expect(bb.rpc("dir_list", { ref: ref(privateData) })).resolves.toMatchObject({ entries: [] });
  await expect(bb.rpc("file_read", { ref: ref(opener.path) })).rejects.toMatchObject({ code: "forbidden" });
  await bb.rpc("agent_grants_set", { grant: { threadId: "thread-edit", endpoint: "host:test", scope: parsePosix("/"), permissions: ["read"] } });
  await expect(bb.tool("list", { ref: ref(privateData) })).resolves.toMatchObject({ entries: [] });
  await expect(bb.tool("search", { root: ref(privateData), name: { glob: "revision-*" } })).resolves.toMatchObject({ hits: [] });
  await expect(bb.tool("read", { ref: ref(opener.path) })).resolves.toEqual({ code: "forbidden", message: "Commander refused the request" });
  await bb.rpc("edit_close", params);
  await expect(readFile(opener.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(bb.rpc("edit_read", { ...params, revision: 0, offset: 0, length: 1 })).rejects.toMatchObject({ code: "not_found" });
});

it("removes orphan copies at startup without removing an open revision", async () => {
  let bb = await start();
  const { opener } = await bb.open();
  const orphan = join(privateData, EDIT_DIRECTORY, randomUUID());
  await mkdir(orphan);
  await writeFile(join(orphan, "revision-0"), "orphan");
  await bb.close();
  bb = await start();
  await expect.poll(async () => (await readdir(join(privateData, EDIT_DIRECTORY))).length).toBe(1);
  expect(await readFile(opener.path, "utf8")).toBe("abc");
});

it("refuses when BB has no primary editor host", async () => {
  const bb = await start(undefined, null);
  await expect(bb.rpc("edit_open", { ref: ref() })).rejects.toMatchObject({ code: "invalid" });
  expect(await readdir(privateData)).toEqual([]);
});

it("requires a single-use SFTP estimate and stores the destination fingerprint after writeback", async () => {
  const remote = new RemoteHubMock();
  remote.seedFile("/remote.txt", "abc");
  const bb = await start(remote);
  const ref = { endpoint: "sftp:5b568675-f842-4a96-83e0-78ae53d96024", path: parsePosix("/remote.txt") };
  await expect(bb.rpc("edit_open", { ref })).rejects.toMatchObject({ code: "forbidden" });
  expect(remote.appliedCount("read")).toBe(0);
  const stale = editRpcSchemas.edit_estimate.output.parse(await bb.rpc("edit_estimate", { ref }));
  expect(stale.bytesPlanned).toBe("3");
  remote.setMtime("/remote.txt", 1700000005);
  await expect(bb.rpc("edit_open", { ref, estimateId: stale.estimateId })).rejects.toMatchObject({ code: "conflict" });
  expect(remote.appliedCount("read")).toBe(0);
  const confirmed = editRpcSchemas.edit_estimate.output.parse(await bb.rpc("edit_estimate", { ref }));
  const opened = editRpcSchemas.edit_open.output.parse(await bb.rpc("edit_open", { ref, estimateId: confirmed.estimateId }));
  expect(opened.base).toEqual({ size: "3", mtimeNs: "1700000005000000000" });
  expect(opened.opener.hostId).toBe("test");
  await bb.save(opened.sessionId, 0);
  const result = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", {
    sessionId: opened.sessionId, revision: 1, clientRequestId: randomUUID(),
  }));
  if (result.kind !== "written") throw new Error("Expected queued write");
  const job = await bb.completed(result.jobId);
  expect(job.plan.items[0]?.expectTarget).toEqual({ size: "3", mtimeNs: "1700000005000000000" });
  const now = editRpcSchemas.edit_get.output.parse(await bb.rpc("edit_get", { sessionId: opened.sessionId }));
  expect(now.base).toEqual({ size: "5", mtimeNs: "1795790479000000000" });
  const read = await bb.rpc("file_read", { ref, mode: "text" });
  expect(read).toMatchObject({ view: { text: "hello" } });
});

it("keeps an active snapshot after closing the tab session and resumes the copy after restart", async () => {
  let bb = await start(undefined, "test", true);
  const { sessionId, opener } = await bb.open();
  await bb.save(sessionId, 0);
  const result = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", {
    sessionId, revision: 1, clientRequestId: randomUUID(),
  }));
  if (result.kind !== "written") throw new Error("Expected queued write");
  await bb.snapshotRead;
  await bb.rpc("edit_close", { sessionId });
  await expect(bb.rpc("edit_get", { sessionId })).rejects.toMatchObject({ code: "not_found" });
  const held = await readdir(join(privateData, EDIT_DIRECTORY, sessionId));
  expect(held).toHaveLength(1);
  expect(held[0]).toMatch(/^snapshot-/);
  expect(await readFile(opener.path).catch(() => null)).toBeNull();
  expect(await readFile(source, "utf8")).toBe("abc");
  await bb.close();
  bb = await start();
  await bb.completed(result.jobId);
  expect(await readFile(source, "utf8")).toBe("hello");
});

it("reaps terminal snapshots while leaving the edit session usable", async () => {
  const bb = await start();
  const { sessionId } = await bb.open();
  for (let revision = 0; revision < 5; revision++) {
    await bb.save(sessionId, revision);
    const result = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", {
      sessionId, revision: revision + 1, clientRequestId: randomUUID(),
    }));
    if (result.kind !== "written") throw new Error("Expected queued write");
    await bb.completed(result.jobId);
  }
  const leaves = await readdir(join(privateData, EDIT_DIRECTORY, sessionId));
  expect(leaves.filter((leaf) => leaf.startsWith("snapshot-")).length).toBeLessThanOrEqual(2);
  expect(leaves).toContain("revision-5");
});

it("discards only the displayed snapshot when choosing not to write", async () => {
  const bb = await start();
  const { sessionId } = await bb.open();
  await bb.save(sessionId, 0);
  await writeFile(source, "outside");
  const result = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", {
    sessionId, revision: 1, clientRequestId: randomUUID(),
  }));
  if (result.kind !== "conflict") throw new Error("Expected conflict");
  await bb.rpc("edit_dismiss", { sessionId, conflictId: result.conflictId });
  expect(await readdir(join(privateData, EDIT_DIRECTORY, sessionId))).toEqual(["revision-1"]);
  expect(await readFile(source, "utf8")).toBe("outside");
  expect(bb.db.prepare("SELECT count(*) AS total FROM jobs").get()).toEqual({ total: 0 });
});

it("hides external hard links from a granted ordinary file provider", async () => {
  const bb = await start();
  const { sessionId, opener } = await bb.open();
  const alias = join(folder, "friendly.txt");
  await link(await realpath(opener.path), alias);
  await bb.rpc("agent_grants_set", { grant: {
    threadId: "thread-edit", endpoint: "host:test", scope: parsePosix(folder), permissions: ["read"],
  } });
  await expect(bb.tool("read", { ref: ref(alias) })).resolves.toEqual({ code: "forbidden", message: "Commander refused the request" });
  await expect(bb.tool("stat", { ref: ref(alias) })).resolves.toMatchObject({ code: "forbidden" });
  await expect(bb.tool("checksum", { ref: ref(alias) })).resolves.toMatchObject({ code: "forbidden" });
  await expect(bb.rpc("plan_create", {
    kind: "copy", sources: [ref(alias)], targetDir: ref(privateData), newName: null,
    conflictPolicy: "ask", verify: "size",
  })).rejects.toMatchObject({ code: "forbidden" });
  await expect(bb.tool("list", { ref: ref(folder) })).resolves.not.toMatchObject({
    entries: expect.arrayContaining([expect.objectContaining({ name: { t: "friendly.txt" } })]),
  });
  await bb.rpc("edit_close", { sessionId });
  await expect(bb.tool("read", { ref: ref(alias) })).resolves.toMatchObject({ code: "forbidden" });
});

it("blocks writeback after the host accepts the first chunk and its reply is lost before restart", async () => {
  let bb = await start();
  const { sessionId } = await bb.open();
  await bb.close();
  bb = await start(undefined, "test", false, { loseChunkReply: true });
  await expect(bb.rpc("edit_save", { sessionId, baseRevision: 0, offset: 0, bytes: "aGU=", final: false })).rejects.toMatchObject({ code: "invalid" });
  await bb.close();
  bb = await start();
  await expect(bb.rpc("edit_writeback", { sessionId, clientRequestId: randomUUID(), revision: 0 }))
    .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Дождитесь сохранения") });
  expect(await readFile(source, "utf8")).toBe("abc");
  expect(bb.db.prepare("SELECT count(*) AS total FROM jobs").get()).toEqual({ total: 0 });
});

it.each([[false, true], [true, false]])("uses endpoint case sensitivity %s for repeated opens", async (caseSensitive, sameSession) => {
  // Simulate both volume policies with distinct directory entries. On a folded
  // volume the second spelling addresses the first existing session.
  const bb = await start(undefined, "test", false, {
    caseSensitive,
    identity(path) {
      const upper = path.segments.at(-1);
      const distinct = caseSensitive && upper && "t" in upper && upper.t === "A.txt";
      return { dev: "5", ino: distinct ? "13" : "12", parentDev: "5", parentIno: "8", name: { t: distinct ? "A.txt" : "a.txt" } };
    },
  });
  const upper = join(folder, "A.txt");
  await writeFile(upper, "abc");
  const first = await bb.open();
  const second = editRpcSchemas.edit_open.output.parse(await bb.rpc("edit_open", { ref: ref(upper) }));
  expect(second.sessionId === first.sessionId).toBe(sameSession);
  expect(bb.db.prepare("SELECT count(*) AS total FROM edit_sessions").get()).toEqual({ total: sameSession ? 1 : 2 });
});

it("issues a new conflict when compare finds changed bytes at identical size and mtime", async () => {
  const bb = await start();
  const { sessionId } = await bb.open();
  const time = 1700000000;
  await writeFile(source, "old");
  await utimes(source, time, time);
  const original = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", { sessionId, clientRequestId: randomUUID(), revision: 0 }));
  if (original.kind !== "conflict") throw new Error("Expected conflict");
  await writeFile(source, "new");
  await utimes(source, time, time);
  const next = await bb.rpc("edit_compare", { sessionId, conflictId: original.conflictId });
  expect(next).toMatchObject({ kind: "conflict", current: { size: "3", mtimeNs: "1700000000000000000" } });
  expect(next).not.toMatchObject({ conflictId: original.conflictId });
  expect(next).not.toHaveProperty("text");
});

it("fails closed in the registered host entry when no private data directory is supplied", async () => {
  const handler = worker.handlers.read as (input: unknown, context: unknown) => Promise<unknown>;
  await expect(handler({ path: parsePosix(source), length: 3, offset: "0", expect: null }, { signal: client.experimental_signal }))
    .rejects.toThrow("Каталог редактора BB недоступен");
});

it("uses the original basename and resolves a new fallback path after saving", async () => {
  const bb = await start();
  const { sessionId, opener } = await bb.open();
  expect(opener.path.split("/").at(-1)).toBe("a.txt");
  await bb.save(sessionId, 0);
  const fresh = await bb.rpc("edit_route", { sessionId }) as { path: string };
  expect(fresh.path.split("/").at(-1)).toBe("a.txt");
  expect(fresh.path).not.toBe(opener.path);
  expect(await readFile(fresh.path, "utf8")).toBe("hello");
});

it("keeps distinct inodes in separate sessions even when host home folds case", async () => {
  const probes: string[] = [];
  const bb = await start(undefined, "test", false, {
    caseSensitive: false,
    identity(path) {
      const leaf = path.segments.at(-1);
      if (!leaf || !("t" in leaf)) throw new Error("Expected a textual fixture path");
      probes.push(leaf.t);
      return { dev: "5", ino: leaf.t === "A.txt" ? "13" : "12", parentDev: "5", parentIno: "8", name: leaf };
    },
  });
  const first = await bb.open();
  const upper = join(folder, "A.txt");
  await writeFile(upper, "different");
  const second = editRpcSchemas.edit_open.output.parse(await bb.rpc("edit_open", { ref: ref(upper) }));
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(await readFile(first.opener.path, "utf8")).toBe("abc");
  expect(await readFile(second.opener.path, "utf8")).toBe("different");
  expect(probes).toEqual(["A.txt", "a.txt"]);
});

it("compares the verified prefix when the original has grown beyond the edit limit", async () => {
  const bb = await start();
  const { sessionId } = await bb.open();
  const contents = Buffer.alloc(16_777_217, 0x61);
  contents.write("verified prefix\n");
  await writeFile(source, contents);
  const shown = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", {
    sessionId, clientRequestId: randomUUID(), revision: 0,
  }));
  if (shown.kind !== "conflict") throw new Error("Expected conflict");
  const result = await bb.rpc("edit_compare", { sessionId, conflictId: shown.conflictId });
  expect(result).toEqual({ kind: "text", text: "verified prefix\n" + "a".repeat(262_128) + "\n…" });
  expect(bb.db.prepare("SELECT count(*) AS total FROM jobs").get()).toEqual({ total: 0 });
});

it("reports equal device and inode for hard links and distinguishes separate files", async () => {
  const bb = await start();
  const handler = worker.handlers.editSourceIdentity;
  const context = { signal: client.experimental_signal, experimental_paths: { dataDir: privateData } } as Parameters<typeof handler>[1];
  const alias = join(folder, "same-inode.txt");
  const distinct = join(folder, "other-inode.txt");
  await link(source, alias);
  await writeFile(distinct, "abc");
  const original = await handler({ path: parsePosix(source) }, context);
  expect(original).toMatchObject({ dev: expect.stringMatching(/^[0-9]+$/), ino: expect.stringMatching(/^[1-9][0-9]*$/) });
  await expect(handler({ path: parsePosix(alias) }, context)).resolves.toEqual({
    ...original, name: { t: "same-inode.txt" },
  });
  await expect(handler({ path: parsePosix(distinct) }, context)).resolves.not.toEqual(original);
  await expect(handler({ path: parsePosix(join(folder, "missing")) }, context)).resolves.toBeNull();
  await bb.close();
});

it("writes through the selected directory entry when case variants have the same inode", async () => {
  const bb = await start(undefined, "test", false, {
    caseSensitive: false,
    identity(path) {
      const name = path.segments.at(-1)!;
      return { dev: "5", ino: "12", parentDev: "5", parentIno: "8", name };
    },
  });
  const upper = join(folder, "A.txt");
  // On a case-sensitive test volume this creates the actual pair. On a folded
  // test volume the worker response supplies the two distinct spellings.
  await link(source, upper).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const lower = await bb.open();
  const opened = editRpcSchemas.edit_open.output.parse(await bb.rpc("edit_open", { ref: ref(upper) }));
  expect(opened.sessionId).not.toBe(lower.sessionId);
  const info = editRpcSchemas.edit_get.output.parse(await bb.rpc("edit_get", { sessionId: opened.sessionId }));
  expect(info.ref.path.segments.at(-1)).toEqual({ t: "A.txt" });
  await bb.save(opened.sessionId, 0);
  const result = editRpcSchemas.edit_writeback.output.parse(await bb.rpc("edit_writeback", {
    sessionId: opened.sessionId, revision: 1, clientRequestId: randomUUID(),
  }));
  if (result.kind !== "written") throw new Error("Expected queued write");
  const job = await bb.completed(result.jobId);
  expect(job.plan.items[0]?.target?.path.segments.at(-1)).toEqual({ t: "A.txt" });
});
