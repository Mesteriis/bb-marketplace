// The Translator port over makosh-ai (slice 3c). Mail never talks to a model
// provider itself: it calls makosh-ai's `ai.v1.*` RPC from the server
// through bb.sdk.plugins.callRpc (caller kind "plugin"), and makosh-ai
// forwards the provider-native body through Account Pooler.
//
// A body mapper is chosen by the provider's API format, not its brand. Until
// makosh-ai lists providers (`ai.v1.providers`, discovered when present: items
// `{ id, displayName, apiFormat, available, reason? }`), the offered providers
// are the static pair with a mapper. The stream is read
// chunk by chunk (base64 bytes of the provider's SSE), and `ai.v1.cancel`
// always runs at the end. Nothing here logs: neither the prompt (the owner's
// mail), the model's text, nor a provider's error body, which is only
// classified by status.
import { experimental_PluginRpcCallError } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  TRANSLATE_OUTPUT_CHARS,
  TranslateError,
  inlineInstructions,
  sanitizeGatewayMessage,
  type TranslateErrorKind,
  type TranslateFinish,
  type TranslateModel,
  type TranslateProvider,
  type Translator,
} from "../../core/translate.ts";
import { createSseReader } from "./sse.ts";

export const MAKOSH_AI_PLUGIN_ID = "makosh-ai";
/** Largest error body read from a provider (status ≥ 400); it is classified, never shown or logged. */
export const ERROR_BODY_MAX_BYTES = 64 * 1024;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** bb.sdk.plugins.callRpc, narrowed to what this adapter uses. */
export type PluginRpcCaller = <T>(args: {
  pluginId: string;
  method: string;
  input: Json;
  outputSchema: z.ZodType<T>;
  signal?: AbortSignal;
}) => Promise<T>;

export type MakoshAiTranslatorDeps = {
  callRpc: PluginRpcCaller;
  /** The method names makosh-ai publishes; empty when it is not installed or disabled. */
  discover: (signal: AbortSignal) => Promise<string[]>;
  /** The id of the first BB project, for `ai.v1.models` while it requires one; null when there is none. */
  firstProjectId: (signal: AbortSignal) => Promise<string | null>;
};

// ---------------------------------------------------------------------------
// Body mappers
// ---------------------------------------------------------------------------

export type ApiFormat = "anthropic-messages" | "openai-responses";

type MapperRequest = { model: string; system: string | null; input: string; maxOutputTokens: number };

/** What one stream event means: text to show, and/or how the stream stopped. */
type EventEffect = {
  text?: string;
  /** complete / max_tokens: the stream ends well; refused and the error kinds: it failed. */
  stop?: TranslateFinish | "refused" | TranslateErrorKind;
  /** A stop reason the stream reports before its last event (Anthropic message_delta). */
  finish?: TranslateFinish;
};

interface BodyMapper {
  /** Whether the route takes a separate system prompt (else the instructions go inline). */
  readonly system: boolean;
  body(request: MapperRequest): Record<string, Json>;
  interpret(type: string, data: Record<string, unknown>): EventEffect;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function anthropicErrorKind(error: Record<string, unknown>): TranslateErrorKind {
  switch (error.type) {
    case "rate_limit_error":
      return "quota";
    case "authentication_error":
    case "permission_error":
      return "auth";
    case "request_too_large":
      return "too_large";
    default:
      return "failed";
  }
}

function openAiErrorKind(error: Record<string, unknown>): TranslateErrorKind {
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "rate_limit_exceeded" || code === "insufficient_quota") return "quota";
  if (code === "invalid_api_key" || code === "unauthorized") return "auth";
  if (code === "model_not_found") return "model_unknown";
  return "failed";
}

const anthropicMessages: BodyMapper = {
  system: true,
  body({ model, system, input, maxOutputTokens }) {
    return {
      model,
      max_tokens: maxOutputTokens,
      stream: true,
      ...(system === null ? {} : { system }),
      messages: [{ role: "user", content: [{ type: "text", text: input }] }],
    };
  },
  interpret(type, data) {
    if (type === "content_block_delta") {
      const delta = asRecord(data.delta);
      return delta.type === "text_delta" && typeof delta.text === "string" ? { text: delta.text } : {};
    }
    if (type === "message_delta") {
      const reason = asRecord(data.delta).stop_reason;
      if (reason === "refusal") return { stop: "refused" };
      if (reason === "max_tokens") return { finish: "max_tokens" };
      return {};
    }
    if (type === "message_stop") return { stop: "complete" };
    if (type === "error") return { stop: anthropicErrorKind(asRecord(data.error)) };
    return {};
  },
};

const openAiResponses: BodyMapper = {
  system: true,
  body({ model, system, input }) {
    // No max_output_tokens: the Codex route refuses it; output is capped by characters.
    return {
      model,
      ...(system === null ? {} : { instructions: system }),
      input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
      stream: true,
      store: false,
    };
  },
  interpret(type, data) {
    if (type === "response.output_text.delta") {
      return typeof data.delta === "string" ? { text: data.delta } : {};
    }
    if (type === "response.refusal.delta" || type === "response.refusal.done") return { stop: "refused" };
    if (type === "response.completed") return { stop: "complete" };
    if (type === "response.incomplete") {
      const reason = asRecord(asRecord(data.response).incomplete_details).reason;
      return { stop: reason === "content_filter" ? "refused" : "max_tokens" };
    }
    if (type === "response.failed") return { stop: openAiErrorKind(asRecord(asRecord(data.response).error)) };
    if (type === "error") return { stop: openAiErrorKind(data) };
    return {};
  },
};

const MAPPERS: Record<ApiFormat, BodyMapper> = {
  "anthropic-messages": anthropicMessages,
  "openai-responses": openAiResponses,
};

/** Until makosh-ai lists its providers: the pair it accepts today, each with its API format. */
const STATIC_PROVIDERS: { id: string; displayName: string; api: ApiFormat }[] = [
  { id: "claude-code", displayName: "Claude Code", api: "anthropic-messages" },
  { id: "codex", displayName: "Codex", api: "openai-responses" },
];

// ---------------------------------------------------------------------------
// makosh-ai's output shapes (read from its contract)
// ---------------------------------------------------------------------------

const startOutput = z.object({ streamId: z.string() });
const readOutput = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  z.object({
    state: z.literal("chunk"),
    cursor: z.number().int(),
    status: z.number().int(),
    contentType: z.string().nullable(),
    data: z.string(),
  }),
  z.object({ state: z.literal("done"), status: z.number().int(), contentType: z.string().nullable() }),
  z.object({ state: z.literal("failed"), message: z.string() }),
]);
const cancelOutput = z.object({ cancelled: z.boolean() });
const modelsOutput = z.object({ models: z.array(z.object({ model: z.string(), displayName: z.string() })) });
/** makosh-ai 0.1.0's `ai.v1.providers`; `reason` says why a provider is unavailable. */
const providersOutput = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      apiFormat: z.string(),
      available: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** HTTP status from the provider (on a chunk or done) as an error kind; the body only tells a model error apart. */
export function statusKind(status: number, body: string): TranslateErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status === 413) return "too_large";
  if (status === 404) return "model_unknown";
  if (status === 400) return /model/i.test(body) ? "model_unknown" : "failed";
  return "failed";
}

/** makosh-ai's stable refusal reasons (its `errorReasons`) as error kinds (slice 3f resolution 15). */
const REASON_KIND: Record<string, TranslateErrorKind> = {
  busy: "busy",
  bridge_missing: "pool_unavailable",
  pool_missing: "pool_unavailable",
  too_large: "too_large",
  forbidden_caller: "failed",
  stream_lost: "failed",
  bad_cursor: "failed",
};

/** A refusal message's leading `<reason>: ` (as makosh-ai's parseReason), when it is a known reason. */
export function parseReasonPrefix(message: string): { reason: string; text: string } | null {
  const match = /^([a-z_]+): /.exec(message);
  if (match === null || !Object.hasOwn(REASON_KIND, match[1]!)) return null;
  return { reason: match[1]!, text: message.slice(match[0].length) };
}

/**
 * A failed makosh-ai call. A known `<reason>: ` prefix decides first; the
 * kept gateway text drops it. Without one, after discovery found makosh-ai,
 * `conflict` and `not_found` are ambiguous and become pool_unavailable with
 * makosh-ai's own text (3c resolution 16); a method that vanished means
 * makosh-ai went away.
 */
function rpcFailure(error: unknown, signal: AbortSignal): TranslateError {
  if (error instanceof TranslateError) return error;
  if (signal.aborted) return new TranslateError("cancelled");
  if (error instanceof experimental_PluginRpcCallError) {
    if (error.code === "unknown_method") return new TranslateError("gateway_missing");
    const prefixed = parseReasonPrefix(error.message);
    if (prefixed !== null) return new TranslateError(REASON_KIND[prefixed.reason]!, prefixed.text);
    if (error.code === "conflict" || error.code === "not_found") {
      return new TranslateError("pool_unavailable", error.message);
    }
  }
  if (error instanceof Error && error.name === "AbortError") return new TranslateError("cancelled");
  return new TranslateError("failed");
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// The translator
// ---------------------------------------------------------------------------

export function createMakoshAiTranslator(deps: MakoshAiTranslatorDeps): Translator {
  /** Providers whose route refused a separate system prompt; the instructions then go inline (until restart). */
  const inlineOnly = new Set<string>();

  const call = <T>(method: string, input: Json, outputSchema: z.ZodType<T>, signal?: AbortSignal) =>
    deps.callRpc({ pluginId: MAKOSH_AI_PLUGIN_ID, method, input, outputSchema, ...(signal ? { signal } : {}) });

  async function methods(signal: AbortSignal): Promise<string[]> {
    let found: string[];
    try {
      found = await deps.discover(signal);
    } catch {
      if (signal.aborted) throw new TranslateError("cancelled");
      found = [];
    }
    if (!found.includes("ai.v1.start")) throw new TranslateError("gateway_missing");
    return found;
  }

  /** Providers with a mapper, each with its format. */
  async function offered(found: string[], signal: AbortSignal): Promise<(TranslateProvider & { api: ApiFormat })[]> {
    if (!found.includes("ai.v1.providers")) {
      return STATIC_PROVIDERS.map((p) => ({ ...p, available: true, reason: null }));
    }
    let listed: z.infer<typeof providersOutput>;
    try {
      listed = await call("ai.v1.providers", {}, providersOutput, signal);
    } catch (error) {
      throw rpcFailure(error, signal);
    }
    return listed.providers
      .filter((p): p is typeof p & { apiFormat: ApiFormat } => Object.hasOwn(MAPPERS, p.apiFormat))
      .map((p) => ({
        id: p.id,
        displayName: p.displayName,
        available: p.available,
        reason: p.reason === undefined ? null : sanitizeGatewayMessage(p.reason),
        api: p.apiFormat,
      }));
  }

  type Attempt = { finish: TranslateFinish } | { retryInline: true };

  /** One stream: start, read to the end (or the character cap), always cancel. */
  async function stream(
    providerId: string,
    mapper: BodyMapper,
    request: MapperRequest,
    onText: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<Attempt> {
    if (signal.aborted) throw new TranslateError("cancelled");
    let streamId: string;
    try {
      ({ streamId } = await call("ai.v1.start", { providerId, body: mapper.body(request) }, startOutput, signal));
    } catch (error) {
      throw rpcFailure(error, signal);
    }

    let shown = 0;
    let stop: EventEffect["stop"] | null = null;
    let finish: TranslateFinish | null = null;
    const reader = createSseReader(({ event, data }) => {
      if (stop !== null) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = asRecord(JSON.parse(data));
      } catch {
        return;
      }
      const type = typeof parsed.type === "string" ? parsed.type : event ?? "";
      const effect = mapper.interpret(type, parsed);
      if (effect.text !== undefined && effect.text !== "") {
        const room = TRANSLATE_OUTPUT_CHARS - shown;
        const text = effect.text.length > room ? cutAt(effect.text, room) : effect.text;
        if (text !== "") {
          shown += text.length;
          onText(text);
        }
        if (effect.text.length > room || shown >= TRANSLATE_OUTPUT_CHARS) {
          stop = "max_tokens";
          return;
        }
      }
      if (effect.finish !== undefined) finish = effect.finish;
      if (effect.stop !== undefined) stop = effect.stop;
    });

    let status = 0;
    const errorBody: Uint8Array[] = [];
    let errorBytes = 0;
    try {
      let cursor = 0;
      for (;;) {
        if (signal.aborted) throw new TranslateError("cancelled");
        let update: z.infer<typeof readOutput>;
        try {
          update = await call("ai.v1.read", { streamId, cursor }, readOutput, signal);
        } catch (error) {
          throw rpcFailure(error, signal);
        }
        if (update.state === "pending") continue;
        if (update.state === "failed") throw new TranslateError("failed");
        if (update.state === "done") {
          status = update.status;
          break;
        }
        // A replayed chunk (same cursor) was already processed.
        if (update.cursor <= cursor) continue;
        cursor = update.cursor;
        status = update.status;
        const bytes = base64Bytes(update.data);
        if (status < 400) {
          // Read as SSE whatever the content type: the Codex route answers with none.
          reader.push(bytes);
          if (stop !== null) break;
        } else if (errorBytes < ERROR_BODY_MAX_BYTES) {
          const part = bytes.slice(0, ERROR_BODY_MAX_BYTES - errorBytes);
          errorBody.push(part);
          errorBytes += part.length;
        }
      }
      if (status < 400 && stop === null) reader.end();
    } finally {
      try {
        await call("ai.v1.cancel", { streamId }, cancelOutput);
      } catch {
        // The stream is gone or makosh-ai went away; nothing more to release.
      }
    }

    if (status >= 400) {
      const body = new TextDecoder().decode(concat(errorBody));
      if (status === 400 && request.system !== null && shown === 0 && !/model/i.test(body)) return { retryInline: true };
      throw new TranslateError(statusKind(status, body));
    }
    const ended = stop as EventEffect["stop"] | null;
    if (ended === "refused") {
      if (request.system !== null && shown === 0) return { retryInline: true };
      throw new TranslateError("refused");
    }
    if (ended === "complete" || ended === null || ended === undefined) return { finish: finish ?? "complete" };
    if (ended === "max_tokens") return { finish: "max_tokens" };
    throw new TranslateError(ended);
  }

  return {
    async providers(signal) {
      const found = await methods(signal);
      return (await offered(found, signal)).map(({ id, displayName, available, reason }) => ({
        id,
        displayName,
        available,
        reason: reason ?? null,
      }));
    },

    async models(providerId, signal): Promise<TranslateModel[]> {
      const found = await methods(signal);
      const provider = (await offered(found, signal)).find((p) => p.id === providerId);
      if (provider === undefined) throw new TranslateError("provider_unknown");
      // With ai.v1.providers comes an optional projectId (spec resolution 4).
      const optionalProject = found.includes("ai.v1.providers");
      const projectId = optionalProject ? null : await deps.firstProjectId(signal);
      if (!optionalProject && projectId === null) return [];
      try {
        const { models } = await call(
          "ai.v1.models",
          projectId === null ? { providerId } : { providerId, projectId },
          modelsOutput,
          signal,
        );
        return models.map(({ model, displayName }) => ({ model, displayName }));
      } catch (error) {
        throw rpcFailure(error, signal);
      }
    },

    async translate(request, onText, signal) {
      const found = await methods(signal);
      const provider = (await offered(found, signal)).find((p) => p.id === request.providerId);
      if (provider === undefined) throw new TranslateError("provider_unknown");
      const mapper = MAPPERS[provider.api];
      const inline = { system: null, input: inlineInstructions(request) };
      const framed = !mapper.system || inlineOnly.has(provider.id) ? inline : { system: request.instructions, input: request.input };
      const base = { model: request.model, maxOutputTokens: request.maxOutputTokens };
      const first = await stream(provider.id, mapper, { ...base, ...framed }, onText, signal);
      if ("finish" in first) return first;
      // The route refused the separate system prompt before any text: once more inline, remembered.
      const second = await stream(provider.id, mapper, { ...base, ...inline }, onText, signal);
      if ("finish" in second) {
        inlineOnly.add(provider.id);
        return second;
      }
      throw new TranslateError("refused");
    },
  };
}

/** The longest prefix of whole code points within `max` UTF-16 units. */
function cutAt(text: string, max: number): string {
  let out = "";
  for (const point of text) {
    if (out.length + point.length > max) break;
    out += point;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
