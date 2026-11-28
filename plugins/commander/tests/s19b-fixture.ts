import { mkdtemp, mkdir, realpath, rm, writeFile, open, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { experimental_defineHostEntry, type BbPluginApi, type ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { expect, vi } from "vitest";
import activate from "../server.ts";
import { createHostFs } from "../src/adapters/bb/host-fs/index.ts";
import { HostFsContract } from "../src/core/wire/host-fs.ts";
import { rpcSchemas } from "../src/core/wire/rpc.ts";
import { fixturePath } from "./host-fs/fixtures.ts";

export async function localStand(options?: Parameters<typeof createHostFs>[0]) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "commander-s19b-"));
  const out = join(root, "out");
  const database = join(root, "jobs.sqlite");
  await mkdir(out);
  await writeFile(join(root, "a.txt"), "abc");
  let migrated = false;
  const kv = new Map<string, unknown>();
  function start(options?: Parameters<typeof createHostFs>[0]) {
    const db = new Database(database);
    const worker = createHostFs(options);
    const host = experimental_createHostEntryHarness(experimental_defineHostEntry({
      contract: HostFsContract, handlers: worker.rpcHandlers, dispose: worker.dispose,
    }));
    const controller = new AbortController();
    const hooks: Array<() => Promise<void>> = [];
    let handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {};
    let service: Promise<void>;
    const call: ExperimentalHostClient<typeof HostFsContract>["call"] = async (method, input, { signal }) => {
      try {
        return await host.experimental_call(method, input, { signal });
      } finally {
        // BB 0.50.1 discards the worker's response once the caller has aborted.
        if (method === "copyWithin" && signal?.aborted) {
          throw new DOMException("Host plugin call was cancelled", "AbortError");
        }
      }
    };
    activate({
      sdk: { hosts: { list: async () => [{ id: "test", name: "Test host" }] },
        plugins: { callRpc: async () => { throw new Error("Remote Hub unavailable"); }, list: async () => { throw new Error("Archive helper unavailable"); } } },
      hosts: { experimental_client: () => ({ call }) },
      storage: {
        database: () => db,
        migrate: (_db: Database.Database, statements: string[]) => {
          if (!migrated) for (const sql of statements) db.exec(sql);
          migrated = true;
        },
        kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { kv.set(key, value); } },
      },
      rpc: { register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; } },
      background: { service: (_name: string, task: { start(signal: AbortSignal): Promise<void> }) => { service = task.start(controller.signal); } },
      onDispose: (hook: () => Promise<void>) => hooks.push(hook),
      realtime: { publish() {} },
      log: { warn() {}, error() {} },
      agents: { registerTool() {} },
      cli: { register() {} },
    } as unknown as BbPluginApi);
    return {
      workerSignal: host.experimental_lifecycleSignal,
      async rpc(method: keyof typeof rpcSchemas, input: unknown, signal = new AbortController().signal): Promise<unknown> {
        const result = await handlers[method]!(input, { experimental_signal: signal, experimental_caller: { kind: "client" } });
        return rpcSchemas[method].output.parse(result);
      },
      async dispose() {
        // BB disposes the host worker before running plugin onDispose hooks.
        await host.experimental_dispose();
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
        await service;
        for (const hook of hooks.reverse()) await hook();
        db.close();
      },
    };
  }
  let server = start(options);
  let enabled = true;
  const ref = (name = "") => ({ endpoint: "host:test", path: fixturePath(join(root, name)) });
  const request = { kind: "copy", sources: [ref("a.txt")], targetDir: ref("out"), newName: null, conflictPolicy: "ask", verify: "size" };
  return {
    root, out, ref, request,
    get rpc() { return server.rpc; },
    get workerSignal() { return server.workerSignal; },
    savedState(jobId: string) {
      const db = new Database(database, { readonly: true });
      try {
        return db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId);
      } finally { db.close(); }
    },
    checkpoint(jobId: string) {
      const db = new Database(database, { readonly: true });
      try {
        return db.prepare("SELECT phase, via FROM checkpoints WHERE job_id = ?").all(jobId);
      } finally { db.close(); }
    },
    async disable() { await server.dispose(); enabled = false; },
    enable() { server = start(); enabled = true; },
    async close() {
      if (enabled) await server.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function waitForJob(rpc: Awaited<ReturnType<typeof localStand>>["rpc"], jobId: string, expected: object) {
  await vi.waitFor(async () => expect(await rpc("job_get", { jobId })).toMatchObject(expected));
}

// Hold a real staging file after its first write so cancellation and unmount
// occur before publication regardless of filesystem speed.
export function pauseAfterWrite() {
  const release = Promise.withResolvers<void>();
  const openStage: typeof open = async (...args) => {
    const file = await open(...args);
    const write = file.write.bind(file);
    file.write = (async (...args: [Buffer, number, number, number]) => {
      const result = await write(...args);
      await release.promise;
      return result;
    }) as typeof file.write;
    return file;
  };
  return { openStage, release: release.resolve };
}

export async function waitForPart(directory: string, size: number) {
  return vi.waitFor(async () => {
    const names = await readdir(directory);
    expect(names).toEqual([expect.stringMatching(/\.part$/)]);
    expect((await lstat(join(directory, names[0]!))).size).toBe(size);
    return names;
  });
}
