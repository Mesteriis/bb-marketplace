import { readFileSync } from "node:fs";
import { experimental_PluginRpcCallError } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  TRANSLATE_MAX_TOKENS,
  TRANSLATE_OUTPUT_CHARS,
  TranslateError,
  buildTranslatePrompt,
  inlineInstructions,
  translationSource,
} from "../../core/translate.ts";
import { createMakoshAiTranslator, statusKind, type PluginRpcCaller } from "./makosh-ai-translator.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const SUBJECT = "Invented garden fence";
const BODY = "Invented note: the gate is open on Tuesday.";
const PROMPT = buildTranslatePrompt(translationSource(SUBJECT, { text: BODY, html: null }).text, { english: "Russian" }, "0123456789abcdef");

type Read =
  | { state: "pending" }
  | { state: "chunk"; cursor: number; status: number; contentType: string | null; data: string }
  | { state: "done"; status: number; contentType: string | null }
  | { state: "failed"; message: string };

/** A chunk of SSE text (or an error body) at `cursor`. */
const chunk = (cursor: number, text: string, status = 200, contentType: string | null = "text/event-stream"): Read => ({
  state: "chunk",
  cursor,
  status,
  contentType,
  data: b64(text),
});
const done = (status = 200): Read => ({ state: "done", status, contentType: null });

/** SSE text split into `pieces` chunks at arbitrary byte boundaries, then done. */
function chunked(text: string, pieces = 3, status = 200, contentType: string | null = "text/event-stream"): Read[] {
  const bytes = Buffer.from(text, "utf8");
  const size = Math.ceil(bytes.length / pieces);
  const reads: Read[] = [];
  for (let i = 0, c = 1; i < bytes.length; i += size, c++) {
    reads.push({ state: "chunk", cursor: c, status, contentType, data: bytes.subarray(i, i + size).toString("base64") });
  }
  return [...reads, done(status)];
}

const sse = (events: { type: string; [key: string]: unknown }[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const claudeText = (...texts: string[]) =>
  sse([
    ...texts.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);

type Call = { method: string; input: Record<string, unknown> };

/** makosh-ai as the translator sees it: discovery, then scripted streams in order. */
class FakeMakoshAi {
  readonly calls: Call[] = [];
  methods = ["ai.v1.models", "ai.v1.start", "ai.v1.read", "ai.v1.cancel"];
  projectId: string | null = "project-1";
  streams: Read[][] = [];
  startError: unknown = null;
  models = [{ model: "invented-model", displayName: "Invented Model" }];
  providers: unknown = null;
  private started = 0;
  private readonly reads = new Map<string, Read[]>();

  readonly callRpc: PluginRpcCaller = async ({ pluginId, method, input, outputSchema, signal }) => {
    expect(pluginId).toBe("makosh-ai");
    this.calls.push({ method, input: input as Record<string, unknown> });
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const answer = (value: unknown) => outputSchema.parse(value);
    if (method === "ai.v1.start") {
      if (this.startError !== null) throw this.startError;
      const streamId = `00000000-0000-4000-8000-00000000000${++this.started}`;
      this.reads.set(streamId, [...(this.streams.shift() ?? [done()])]);
      return answer({ streamId });
    }
    if (method === "ai.v1.read") {
      const queue = this.reads.get((input as { streamId: string }).streamId)!;
      const next = queue.shift() ?? done();
      return answer(next);
    }
    if (method === "ai.v1.cancel") return answer({ cancelled: true });
    if (method === "ai.v1.models") return answer({ models: this.models });
    if (method === "ai.v1.providers") return answer(this.providers);
    throw new Error(`unexpected ${method}`);
  };

  translator() {
    return createMakoshAiTranslator({
      callRpc: this.callRpc,
      discover: async () => this.methods,
      firstProjectId: async () => this.projectId,
    });
  }

  of(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.input);
  }
}

async function run(
  ai: FakeMakoshAi,
  providerId = "claude-code",
  signal = new AbortController().signal,
): Promise<{ text: string; result: { finish: string } | null; error: TranslateError | null }> {
  let text = "";
  try {
    const result = await ai.translator().translate(
      { providerId, model: "invented-model", ...PROMPT, maxOutputTokens: TRANSLATE_MAX_TOKENS },
      (delta) => {
        text += delta;
      },
      signal,
    );
    return { text, result, error: null };
  } catch (error) {
    if (!(error instanceof TranslateError)) throw error;
    return { text, result: null, error };
  }
}

describe("createMakoshAiTranslator: streams", () => {
  it("reads the Claude fixture split across chunks and cancels at the end", async () => {
    const ai = new FakeMakoshAi();
    ai.streams = [chunked(fixture("anthropic-messages.sse.txt"), 7)];
    const out = await run(ai);
    expect(out).toEqual({ text: "Привет, сад 花园\nвторая строка", result: { finish: "complete" }, error: null });
    expect(ai.of("ai.v1.cancel")).toHaveLength(1);
  });

  it("reads the Codex fixture with contentType null as SSE", async () => {
    const ai = new FakeMakoshAi();
    ai.streams = [chunked(fixture("openai-responses.sse.txt"), 5, 200, null)];
    const out = await run(ai, "codex");
    expect(out).toEqual({ text: "Привет, сад 花园", result: { finish: "complete" }, error: null });
    expect(ai.of("ai.v1.cancel")).toHaveLength(1);
  });

  it("reads again with the same cursor on pending, and a replayed chunk adds no text twice", async () => {
    const ai = new FakeMakoshAi();
    const text = claudeText("один ", "два");
    const half = Math.floor(text.length / 2);
    ai.streams = [[{ state: "pending" }, chunk(1, text.slice(0, half)), chunk(1, text.slice(0, half)), { state: "pending" }, chunk(2, text.slice(half)), done()]];
    const out = await run(ai);
    expect(out.text).toBe("один два");
    expect(ai.of("ai.v1.read").map((r) => r.cursor)).toEqual([0, 0, 1, 1, 1]);
  });

  it("Claude: max_tokens stop finishes cut short; refusal after text is refused", async () => {
    const cut = new FakeMakoshAi();
    cut.streams = [chunked(sse([
      { type: "content_block_delta", delta: { type: "text_delta", text: "часть" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      { type: "message_stop" },
    ]))];
    expect(await run(cut)).toMatchObject({ text: "часть", result: { finish: "max_tokens" } });

    const refused = new FakeMakoshAi();
    refused.streams = [chunked(sse([
      { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
      { type: "message_delta", delta: { stop_reason: "refusal" } },
    ]))];
    const out = await run(refused);
    expect(out.error?.kind).toBe("refused");
    expect(refused.of("ai.v1.start")).toHaveLength(1);
    expect(refused.of("ai.v1.cancel")).toHaveLength(1);
  });

  it("Codex: incomplete is cut short, failed and error events map by code, a refusal is refused", async () => {
    const cases: [string, string, unknown][] = [
      [sse([{ type: "response.output_text.delta", delta: "a" }, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }]), "max_tokens", null],
      [sse([{ type: "response.failed", response: { error: { code: "rate_limit_exceeded" } } }]), "", "quota"],
      [sse([{ type: "error", code: "invalid_api_key" }]), "", "auth"],
      [sse([{ type: "response.failed", response: { error: { code: "server_error" } } }]), "", "failed"],
      [sse([{ type: "response.refusal.delta", delta: "no" }]), "", "refused"],
    ];
    for (const [text, finish, kind] of cases) {
      const ai = new FakeMakoshAi();
      ai.streams = [chunked(text), chunked(text)];
      const out = await run(ai, "codex");
      if (kind === null) expect(out.result).toEqual({ finish });
      else expect(out.error?.kind).toBe(kind);
      expect(ai.of("ai.v1.cancel").length).toBe(ai.of("ai.v1.start").length);
    }
  });

  it("Claude error events map by type", async () => {
    for (const [type, kind] of [["rate_limit_error", "quota"], ["authentication_error", "auth"], ["overloaded_error", "failed"]]) {
      const ai = new FakeMakoshAi();
      ai.streams = [chunked(sse([{ type: "error", error: { type } }]))];
      expect((await run(ai)).error?.kind).toBe(kind);
    }
  });

  it("cancels the stream at the output character cap and reports it cut short", async () => {
    const ai = new FakeMakoshAi();
    const delta = sse([{ type: "content_block_delta", delta: { type: "text_delta", text: "я".repeat(40_000) } }]);
    ai.streams = [[chunk(1, delta), chunk(2, delta), chunk(3, delta), chunk(4, claudeText("tail")), done()]];
    const out = await run(ai);
    expect(out.result).toEqual({ finish: "max_tokens" });
    expect(out.text.length).toBe(TRANSLATE_OUTPUT_CHARS);
    expect(ai.of("ai.v1.read")).toHaveLength(3);
    expect(ai.of("ai.v1.cancel")).toHaveLength(1);
  });

  it("never cuts a surrogate pair at the character cap", async () => {
    const ai = new FakeMakoshAi();
    ai.streams = [[chunk(1, claudeText("a".repeat(TRANSLATE_OUTPUT_CHARS - 1) + "😀😀")), done()]];
    const out = await run(ai);
    expect(out.text.length).toBe(TRANSLATE_OUTPUT_CHARS - 1);
    expect(out.result).toEqual({ finish: "max_tokens" });
  });

  it("cancels on abort, on a failed read and on an error status", async () => {
    const aborted = new FakeMakoshAi();
    const controller = new AbortController();
    aborted.streams = [[{ state: "pending" }, { state: "pending" }]];
    const reading = aborted.callRpc;
    let reads = 0;
    (aborted as { callRpc: PluginRpcCaller }).callRpc = async (args) => {
      if (args.method === "ai.v1.read" && ++reads === 2) controller.abort();
      return reading(args);
    };
    expect((await run(aborted, "claude-code", controller.signal)).error?.kind).toBe("cancelled");
    expect(aborted.of("ai.v1.cancel")).toHaveLength(1);

    const failed = new FakeMakoshAi();
    failed.streams = [[{ state: "failed", message: "Invented upstream reset" }]];
    const out = await run(failed);
    expect(out.error?.kind).toBe("failed");
    expect(out.error?.message).not.toContain("Invented");
    expect(failed.of("ai.v1.cancel")).toHaveLength(1);

    const status = new FakeMakoshAi();
    status.streams = [chunked('{"error":{"message":"quota for invented user"}}', 1, 429, "application/json")];
    expect((await run(status)).error?.kind).toBe("quota");
    expect(status.of("ai.v1.cancel")).toHaveLength(1);
  });

  it("an aborted signal before start makes no call to start", async () => {
    const ai = new FakeMakoshAi();
    const controller = new AbortController();
    controller.abort();
    expect((await run(ai, "claude-code", controller.signal)).error?.kind).toBe("cancelled");
    expect(ai.of("ai.v1.start")).toEqual([]);
  });
});

describe("createMakoshAiTranslator: errors and providers", () => {
  it("maps statuses", () => {
    expect(statusKind(401, "")).toBe("auth");
    expect(statusKind(403, "")).toBe("auth");
    expect(statusKind(429, "")).toBe("quota");
    expect(statusKind(413, "")).toBe("too_large");
    expect(statusKind(404, "")).toBe("model_unknown");
    expect(statusKind(400, '{"error":"unknown model x"}')).toBe("model_unknown");
    expect(statusKind(400, '{"error":"bad"}')).toBe("failed");
    expect(statusKind(500, "")).toBe("failed");
    expect(statusKind(503, "")).toBe("failed");
  });

  it("is gateway_missing when discovery finds nothing or throws, without calling makosh-ai", async () => {
    for (const discover of [async () => [] as string[], async () => Promise.reject(new Error("no"))]) {
      const ai = new FakeMakoshAi();
      const translator = createMakoshAiTranslator({ callRpc: ai.callRpc, discover, firstProjectId: async () => "p" });
      const signal = new AbortController().signal;
      await expect(translator.providers(signal)).rejects.toMatchObject({ kind: "gateway_missing" });
      await expect(translator.models("codex", signal)).rejects.toMatchObject({ kind: "gateway_missing" });
      await expect(
        translator.translate({ providerId: "codex", model: "m", ...PROMPT, maxOutputTokens: 1 }, () => {}, signal),
      ).rejects.toMatchObject({ kind: "gateway_missing" });
      expect(ai.calls).toEqual([]);
    }
  });

  it("after discovery, a conflict or not_found refusal is pool_unavailable with makosh-ai's sanitized message", async () => {
    for (const code of ["conflict", "not_found"] as const) {
      const ai = new FakeMakoshAi();
      ai.startError = new experimental_PluginRpcCallError({
        code,
        message: `Account Pooler model RPC is unavailable.\u0007\n${"x".repeat(400)}`,
      });
      const out = await run(ai);
      expect(out.error?.kind).toBe("pool_unavailable");
      expect(out.error?.gatewayMessage?.startsWith("Account Pooler model RPC is unavailable. x")).toBe(true);
      expect(out.error!.gatewayMessage!.length).toBeLessThanOrEqual(200);
      expect(out.error!.gatewayMessage).not.toMatch(/[\u0000-\u001f]/);
    }
    const gone = new FakeMakoshAi();
    gone.startError = new experimental_PluginRpcCallError({ code: "unknown_method", message: "gone" });
    expect((await run(gone)).error?.kind).toBe("gateway_missing");
    const other = new FakeMakoshAi();
    other.startError = new experimental_PluginRpcCallError({ code: "transport_error", message: "x" });
    expect((await run(other)).error?.kind).toBe("failed");
  });

  it("an unknown provider is provider_unknown with no stream started", async () => {
    const ai = new FakeMakoshAi();
    expect((await run(ai, "invented-provider")).error?.kind).toBe("provider_unknown");
    expect(ai.of("ai.v1.start")).toEqual([]);
  });

  it("offers the static pair until makosh-ai lists providers, then only those with a mapper", async () => {
    const ai = new FakeMakoshAi();
    const signal = new AbortController().signal;
    expect(await ai.translator().providers(signal)).toEqual([
      { id: "claude-code", displayName: "Claude Code", available: true, reason: null },
      { id: "codex", displayName: "Codex", available: true, reason: null },
    ]);
    ai.methods = [...ai.methods, "ai.v1.providers"];
    // makosh-ai 0.1.0's ai.v1.providers shape (its contract), synthetic values.
    ai.providers = {
      providers: [
        { id: "claude-code", displayName: "Claude Code", apiFormat: "anthropic-messages", available: true },
        { id: "codex", displayName: "Codex", apiFormat: "openai-responses", available: false, reason: "bridge_missing" },
        { id: "invented", displayName: "Invented", apiFormat: "invented-api", available: true },
      ],
    };
    expect(await ai.translator().providers(signal)).toEqual([
      { id: "claude-code", displayName: "Claude Code", available: true, reason: null },
      { id: "codex", displayName: "Codex", available: false, reason: "bridge_missing" },
    ]);
  });

  it("pins makosh-ai's providers shape: the old mail-side shape is not read", async () => {
    const ai = new FakeMakoshAi();
    ai.methods = [...ai.methods, "ai.v1.providers"];
    ai.providers = {
      providers: [{ providerId: "codex", displayName: "Codex", api: "openai-responses", available: true }],
    };
    await expect(ai.translator().providers(new AbortController().signal)).rejects.toBeTruthy();
  });

  it("maps makosh-ai's reason prefixes; the kept text drops the prefix", async () => {
    const cases = [
      ["busy", "conflict", "busy"],
      ["bridge_missing", "conflict", "pool_unavailable"],
      ["pool_missing", "not_found", "pool_unavailable"],
      ["too_large", "invalid", "too_large"],
      ["forbidden_caller", "forbidden", "failed"],
      ["stream_lost", "not_found", "failed"],
      ["bad_cursor", "conflict", "failed"],
    ] as const;
    for (const [reason, code, kind] of cases) {
      const ai = new FakeMakoshAi();
      ai.startError = new experimental_PluginRpcCallError({ code, message: `${reason}: Invented gateway text.` });
      const out = await run(ai);
      expect(out.error?.kind, reason).toBe(kind);
      if (kind === "pool_unavailable") expect(out.error?.gatewayMessage).toBe("Invented gateway text.");
    }
  });

  it("a read that fails with stream_lost or bad_cursor is failed, never pool_unavailable", async () => {
    for (const reason of ["stream_lost", "bad_cursor"] as const) {
      const ai = new FakeMakoshAi();
      const base = ai.callRpc;
      const translator = createMakoshAiTranslator({
        callRpc: async (args) => {
          if (args.method === "ai.v1.read") {
            throw new experimental_PluginRpcCallError({ code: "not_found", message: `${reason}: Invented.` });
          }
          return base(args);
        },
        discover: async () => ai.methods,
        firstProjectId: async () => "p",
      });
      await expect(
        translator.translate({ providerId: "codex", model: "m", ...PROMPT, maxOutputTokens: 1 }, () => {}, new AbortController().signal),
      ).rejects.toMatchObject({ kind: "failed" });
    }
  });

  it("an unknown prefix or none keeps the code mapping", async () => {
    const unknownPrefix = new FakeMakoshAi();
    unknownPrefix.startError = new experimental_PluginRpcCallError({ code: "conflict", message: "invented_reason: Text." });
    const out = await run(unknownPrefix);
    expect(out.error?.kind).toBe("pool_unavailable");
    expect(out.error?.gatewayMessage).toBe("invented_reason: Text.");
    const bare = new FakeMakoshAi();
    bare.startError = new experimental_PluginRpcCallError({ code: "conflict", message: "Bridge not ready." });
    expect((await run(bare)).error).toMatchObject({ kind: "pool_unavailable", gatewayMessage: "Bridge not ready." });
    const gone = new FakeMakoshAi();
    gone.startError = new experimental_PluginRpcCallError({ code: "unknown_method", message: "busy: gone" });
    expect((await run(gone)).error?.kind).toBe("gateway_missing");
  });

  it("lists models with the first project's id, none without a project, and without projectId once providers are listed", async () => {
    const ai = new FakeMakoshAi();
    const signal = new AbortController().signal;
    expect(await ai.translator().models("codex", signal)).toEqual([{ model: "invented-model", displayName: "Invented Model" }]);
    expect(ai.of("ai.v1.models")).toEqual([{ providerId: "codex", projectId: "project-1" }]);
    ai.projectId = null;
    expect(await ai.translator().models("codex", signal)).toEqual([]);
    expect(ai.of("ai.v1.models")).toHaveLength(1);
    ai.methods = [...ai.methods, "ai.v1.providers"];
    ai.providers = { providers: [{ id: "codex", displayName: "Codex", apiFormat: "openai-responses", available: true }] };
    await ai.translator().models("codex", signal);
    expect(ai.of("ai.v1.models").at(-1)).toEqual({ providerId: "codex" });
  });
});

describe("createMakoshAiTranslator: request bodies", () => {
  it("Claude: max_tokens, system, one text part with only the framed subject and body; no conversationId", async () => {
    const ai = new FakeMakoshAi();
    ai.streams = [chunked(claudeText("ok"))];
    await run(ai);
    const [start] = ai.of("ai.v1.start");
    expect(Object.keys(start!).sort()).toEqual(["body", "providerId"]);
    expect(start).toEqual({
      providerId: "claude-code",
      body: {
        model: "invented-model",
        max_tokens: TRANSLATE_MAX_TOKENS,
        stream: true,
        system: PROMPT.instructions,
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT.input }] }],
      },
    });
    expect(PROMPT.input).toContain(SUBJECT);
    expect(PROMPT.input).toContain(BODY);
  });

  it("Codex: instructions and input_text, stream and store false, no max_output_tokens and no image part", async () => {
    const ai = new FakeMakoshAi();
    ai.streams = [chunked(fixture("openai-responses.sse.txt"))];
    await run(ai, "codex");
    const [start] = ai.of("ai.v1.start");
    expect(start).toEqual({
      providerId: "codex",
      body: {
        model: "invented-model",
        instructions: PROMPT.instructions,
        input: [{ role: "user", content: [{ type: "input_text", text: PROMPT.input }] }],
        stream: true,
        store: false,
      },
    });
    const text = JSON.stringify(start);
    expect(text).not.toContain("max_output_tokens");
    expect(text).not.toContain("image");
    expect(text).not.toContain("conversationId");
  });

  it("Claude: a 400 before any text with a system prompt retries once inline, and remembers it", async () => {
    const ai = new FakeMakoshAi();
    const translator = ai.translator();
    ai.streams = [chunked('{"error":"system not allowed"}', 1, 400, "application/json"), chunked(claudeText("готово")), chunked(claudeText("снова"))];
    const signal = new AbortController().signal;
    const request = { providerId: "claude-code", model: "invented-model", ...PROMPT, maxOutputTokens: TRANSLATE_MAX_TOKENS };
    let text = "";
    expect(await translator.translate(request, (d) => (text += d), signal)).toEqual({ finish: "complete" });
    expect(text).toBe("готово");
    const starts = ai.of("ai.v1.start").map((s) => s.body as Record<string, unknown>);
    expect(starts).toHaveLength(2);
    expect(starts[0]!.system).toBe(PROMPT.instructions);
    expect(starts[1]).not.toHaveProperty("system");
    expect(starts[1]!.messages).toEqual([{ role: "user", content: [{ type: "text", text: inlineInstructions(PROMPT) }] }]);
    expect(ai.of("ai.v1.cancel")).toHaveLength(2);

    await translator.translate(request, () => {}, signal);
    const third = ai.of("ai.v1.start")[2]!.body as Record<string, unknown>;
    expect(third).not.toHaveProperty("system");
  });

  it("Claude: a refusal before any text retries inline once; a second refusal is refused", async () => {
    const ai = new FakeMakoshAi();
    const refusal = sse([{ type: "message_delta", delta: { stop_reason: "refusal" } }, { type: "message_stop" }]);
    ai.streams = [chunked(refusal), chunked(refusal)];
    const out = await run(ai);
    expect(out.error?.kind).toBe("refused");
    expect(ai.of("ai.v1.start")).toHaveLength(2);
  });

  it("a 400 naming the model is model_unknown with no inline retry", async () => {
    const ai = new FakeMakoshAi();
    ai.streams = [chunked('{"error":"model invented-model not found"}', 1, 400, "application/json")];
    expect((await run(ai)).error?.kind).toBe("model_unknown");
    expect(ai.of("ai.v1.start")).toHaveLength(1);
  });
});
