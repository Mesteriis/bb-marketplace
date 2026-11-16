import { experimental_PluginRpcCallError } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";
import { registerPoolModelApi } from "./src/adapters/bb/pool-bridge";

const caller = (pluginId: string) => ({ experimental_caller: { kind: "plugin", pluginId } } as const);
const request = {
  providerId: "codex",
  body: { model: "fixture-model", input: "Hello" },
  conversationId: "fixture",
};
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

async function setup(send: Parameters<typeof registerPoolModelApi>[1]) {
  const pool = createFakePluginHost({ pluginId: "account-pool" });
  registerPoolModelApi(pool.bb, send);
  const callRpc = vi.fn(async ({ method, input, outputSchema, signal }) => outputSchema.parse(
    await pool.harness.behavior.callRpc(method, input, { ...caller("makosh-ai"), signal }),
  ));
  const { bb, harness } = createFakePluginHost({
    pluginId: "makosh-ai",
    sdk: { plugins: { callRpc } },
  });
  disposers.push(() => pool.harness.lifecycle.dispose(), () => harness.lifecycle.dispose());
  await plugin(bb);
  const call = (method: string, data: unknown, owner = "consumer") =>
    harness.behavior.callRpc(method, data, caller(owner));
  const start = async (data: unknown = request, owner?: string) =>
    await call("ai.v1.start", data, owner) as { streamId: string };
  return { call, start, pool, harness, callRpc };
}

describe("Makosh AI transport", () => {
  it("streams the raw pooled response in retryable chunks and preserves final status", async () => {
    const bytes = new TextEncoder().encode("x".repeat(40_000) + "🦉");
    const send = vi.fn(async (_request: Request, _provider: string, _route: string) => new Response(bytes, {
      status: 200, headers: { "content-type": "text/event-stream" },
    }));
    const host = await setup(send);
    const stream = await host.start();
    const read = (cursor: number) => host.call("ai.v1.read", { ...stream, cursor });
    const [first, duplicate] = await Promise.all([read(0), read(0)]) as [
      { cursor: number; data: string }, unknown,
    ];
    expect(duplicate).toEqual(first);
    expect(await read(0)).toEqual(first);
    const second = await read(first.cursor) as { cursor: number; data: string };
    expect(Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")]))
      .toEqual(Buffer.from(bytes));
    expect(await read(second.cursor)).toEqual({
      state: "done", status: 200, contentType: "text/event-stream",
    });
    const [forwarded, provider, route] = send.mock.calls[0];
    expect([provider, route]).toEqual(["codex", "/v1/responses"]);
    expect(await forwarded.json()).toEqual({ ...request.body, stream: true, store: false });
  });

  it("lets the caller replay conversation history with stable caller-scoped affinity", async () => {
    const send = vi.fn(async (_request: Request) => new Response(null, { status: 204 }));
    const host = await setup(send);
    await host.start();
    const history = [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi!" }];
    await host.start({ ...request, body: { ...request.body, input: history } });
    await host.start(request, "another");
    const [first, second, other] = send.mock.calls.map(([forwarded]) => forwarded);
    expect(first.headers.get("thread-id")).toBe(second.headers.get("thread-id"));
    expect(first.headers.get("thread-id")).not.toBe(other.headers.get("thread-id"));
    expect(await second.json()).toMatchObject({ input: history });
  });

  it("rejects provider-owned continuation and exposes no direct client or pool bypass", async () => {
    const send = vi.fn();
    const host = await setup(send);
    await expect(host.start({ ...request, body: { ...request.body, previous_response_id: "resp_other" } }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(host.harness.behavior.callRpc("ai.v1.start", request))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(host.pool.harness.behavior.callRpc("model-api.v1.start", {
      owner: "consumer", request,
    }, caller("consumer"))).rejects.toMatchObject({ code: "forbidden" });
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when the required pool RPC is missing", async () => {
    const callRpc = vi.fn(async () => {
      throw new experimental_PluginRpcCallError({ code: "unknown_method", message: "Unknown method" });
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "makosh-ai", sdk: { plugins: { callRpc } },
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("ai.v1.start", request, caller("consumer")))
      .rejects.toThrow("The Makosh bridge is required.");
    expect(callRpc).toHaveBeenCalledTimes(1);
    expect(callRpc).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "account-pool", method: "model-api.v1.start",
    }));
  });

  it("isolates streams by caller and aborts the pool request on cancellation", async () => {
    const send = vi.fn(async (_request: Request) => new Response(new ReadableStream()));
    const host = await setup(send);
    const stream = await host.start();
    await expect(host.call("ai.v1.read", { ...stream, cursor: 0 }, "another"))
      .rejects.toMatchObject({ code: "not_found" });
    expect(await host.call("ai.v1.cancel", stream, "another")).toEqual({ cancelled: false });
    expect(await host.call("ai.v1.cancel", stream)).toEqual({ cancelled: true });
    expect(send.mock.calls[0][0].signal.aborted).toBe(true);
  });
});

const nobody = "00000000-0000-4000-8000-000000000000";

function failingPool(error: unknown, extraSdk: Record<string, unknown> = {}) {
  const callRpc = vi.fn(async () => {
    throw error;
  });
  return createFakePluginHost({ pluginId: "makosh-ai", sdk: { plugins: { callRpc }, ...extraSdk } });
}

describe("Makosh AI providers", () => {
  it("lists every routable provider with its API format when the bridge answers", async () => {
    const host = await setup(vi.fn());
    expect(await host.call("ai.v1.providers", {})).toEqual({
      providers: [
        { id: "claude-code", displayName: "Claude Code", apiFormat: "anthropic-messages", available: true },
        { id: "codex", displayName: "Codex", apiFormat: "openai-responses", available: true },
      ],
    });
    expect(host.callRpc).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "account-pool", method: "model-api.v1.cancel",
    }));
  });

  it.each([
    ["unknown_method", "bridge_missing"],
    ["not_found", "pool_missing"],
  ] as const)("marks providers unavailable when the pool answers %s", async (code, reason) => {
    const { bb, harness } = failingPool(new experimental_PluginRpcCallError({ code, message: "x" }));
    await plugin(bb);
    const { providers } = await harness.behavior.callRpc("ai.v1.providers", {}, caller("consumer")) as {
      providers: { id: string; available: boolean; reason?: string }[];
    };
    expect(providers.map(({ id }) => id)).toEqual(["claude-code", "codex"]);
    expect(providers.every((entry) => !entry.available && entry.reason === reason)).toBe(true);
  });

  it("refuses non-plugin callers", async () => {
    const host = await setup(vi.fn());
    await expect(host.harness.behavior.callRpc("ai.v1.providers", {}))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/^forbidden_caller: /) });
  });
});

describe("Makosh AI models", () => {
  const catalog = {
    modelLoadError: null,
    models: [{
      defaultReasoningEffort: "medium", description: "", displayName: "Fixture", id: "fixture",
      isDefault: true, model: "fixture-model", reasoningDiscovery: "known",
    }],
  };

  it.each([
    [{ providerId: "codex" }, { providerId: "codex" }],
    [{ providerId: "codex", projectId: "project" }, { providerId: "codex", projectId: "project" }],
  ])("reads the BB catalog for %j", async (input, expected) => {
    const models = vi.fn(async () => catalog);
    const { bb, harness } = failingPool(new Error("unused"), { providers: { models } });
    await plugin(bb);
    expect(await harness.behavior.callRpc("ai.v1.models", input, caller("consumer")))
      .toEqual({ models: [{ model: "fixture-model", displayName: "Fixture" }] });
    const [args] = models.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(args).filter((key) => key !== "signal").sort()).toEqual(Object.keys(expected).sort());
    expect(args).toMatchObject(expected);
  });
});

describe("Makosh AI error reasons", () => {
  const reason = (code: string, prefix: string) =>
    expect.objectContaining({ code, message: expect.stringMatching(new RegExp(`^${prefix}: `)) });

  it("prefixes a missing bridge and a missing pool", async () => {
    for (const [code, expected, prefix] of [
      ["unknown_method", "conflict", "bridge_missing"],
      ["not_found", "not_found", "pool_missing"],
    ] as const) {
      const { bb, harness } = failingPool(new experimental_PluginRpcCallError({ code, message: "x" }));
      await plugin(bb);
      await expect(harness.behavior.callRpc("ai.v1.start", request, caller("consumer")))
        .rejects.toEqual(reason(expected, prefix));
    }
  });

  it("prefixes busy, lost-stream and cursor refusals from the bridge", async () => {
    const host = await setup(vi.fn(async (_request: Request) => new Response(new ReadableStream())));
    const streams = [];
    for (let index = 0; index < 8; index += 1) streams.push(await host.start());
    await expect(host.start()).rejects.toEqual(reason("conflict", "busy"));
    await expect(host.call("ai.v1.read", { streamId: nobody, cursor: 0 }))
      .rejects.toEqual(reason("not_found", "stream_lost"));
    await expect(host.call("ai.v1.read", { ...streams[0], cursor: 5 }))
      .rejects.toEqual(reason("conflict", "bad_cursor"));
  });

  it("prefixes an oversized request", async () => {
    const host = await setup(vi.fn());
    await expect(host.start({ ...request, body: { ...request.body, input: "x".repeat(8 * 1024 * 1024) } }))
      .rejects.toEqual(reason("invalid", "too_large"));
  });
});
