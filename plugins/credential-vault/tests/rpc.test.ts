import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import type { BbPluginApi, ExperimentalPluginRpcCaller } from "@get-bb/plugin-sdk";

const readKey = mock(async (_root: string, _account: string, _mode: string): Promise<{ key: Buffer } | { state: string }> =>
  ({ key: Buffer.alloc(32, 42) }),
);
mock.module("../src/adapters/bb/keychain", () => ({ readKey }));

const { default: plugin } = await import("../server.ts");

function fixture() {
  const database = new Database(":memory:");
  const lifecycle = new AbortController();
  let serviceDone: Promise<void> | undefined;
  let dispose: (() => void) | undefined;
  let handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {};
  const pluginId = "makosh-credential-vault";
  const bb = {
    pluginId,
    sdk: { plugins: { list: async () => ({ plugins: [{ id: pluginId, rootDir: "/test/plugin" }] }) } },
    storage: {
      database: () => database,
      migrate: (db: Database, statements: string[]) => {
        for (const sql of statements) db.exec(sql);
      },
    },
    background: {
      service: (_name: string, service: { start(signal: AbortSignal): Promise<void> }) => {
        serviceDone = service.start(lifecycle.signal);
      },
    },
    onDispose: (cleanup: () => void) => { dispose = cleanup; },
    rpc: {
      register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; },
    },
  } as unknown as BbPluginApi;

  plugin(bb);
  return {
    call: (method: string, input: unknown, caller: ExperimentalPluginRpcCaller = { kind: "client" }) =>
      handlers[method](input, { experimental_caller: caller, experimental_signal: lifecycle.signal }),
    async close() {
      lifecycle.abort();
      dispose?.();
      await serviceDone;
      database.close();
    },
  };
}

test("registered secret RPCs take their namespace from the caller and refuse client access", async () => {
  const a = { kind: "plugin", pluginId: "plugin-a" } as const;
  const b = { kind: "plugin", pluginId: "plugin-b" } as const;
  const client = { kind: "client" } as const;
  const { call, close } = fixture();
  try {
    const ref = "account-1";
    await expect(call("experimental_put", { ref, secret: "synthetic value" }, a)).resolves.toEqual({ stored: true });
    await expect(call("experimental_get", { ref, pluginId: a.pluginId }, b)).resolves.toEqual({ secret: null });
    await expect(call("experimental_get", { ref }, client)).rejects.toMatchObject({ code: "forbidden" });
    await expect(call("experimental_put", { ref, secret: "forged" }, client)).rejects.toMatchObject({ code: "forbidden" });
    await expect(call("experimental_remove", { ref }, client)).rejects.toMatchObject({ code: "forbidden" });
    await expect(call("experimental_get", { ref }, a)).resolves.toEqual({ secret: "synthetic value" });
  } finally {
    await close();
  }
});

test("missing default Keychain never triggers an interactive or create operation", async () => {
  readKey.mockClear();
  readKey.mockResolvedValueOnce({ state: "no_keychain" });
  const { call, close } = fixture();
  try {
    const consumer = { kind: "plugin", pluginId: "plugin-a" } as const;
    await expect(call("experimental_get", { ref: "test" }, consumer)).rejects.toMatchObject({ code: "conflict" });
    expect(await call("vault_status", null)).toEqual({ state: "no_keychain" });
    expect(readKey.mock.calls.map(([, , mode]) => mode)).toEqual(["read"]);
  } finally {
    await close();
  }
});

test("startup requests approval once for the master key and later reads use the open vault", async () => {
  readKey.mockClear();
  readKey.mockResolvedValueOnce({ state: "approval" });
  const { call, close } = fixture();
  try {
    const consumer = { kind: "plugin", pluginId: "plugin-a" } as const;
    await call("experimental_put", { ref: "first", secret: "fixture one" }, consumer);
    await call("experimental_put", { ref: "second", secret: "fixture two" }, consumer);
    await expect(call("experimental_get", { ref: "second" }, consumer)).resolves.toEqual({ secret: "fixture two" });
    expect(readKey.mock.calls.map(([, , mode]) => mode)).toEqual(["read", "approve"]);
  } finally {
    await close();
  }
});
