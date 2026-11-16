import { createHash, randomUUID } from "node:crypto";
import {
  defineRpcContract,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type ExperimentalPluginRpcHandlerContext,
} from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  cancelOutput, handle, poolCancel, poolRead, poolStart, providerEntry, readOutput,
} from "../../core/contract.js";

const contract = defineRpcContract({
  "model-api.v1.start": { input: poolStart, output: handle },
  "model-api.v1.read": { input: poolRead, output: readOutput },
  "model-api.v1.cancel": { input: poolCancel, output: cancelOutput },
});

type ReadResult = z.infer<typeof readOutput>;
type ModelStream = {
  owner: string;
  controller: AbortController;
  reader: Promise<Response>;
  body?: ReadableStreamDefaultReader<Uint8Array>;
  cursor: number;
  remainder?: Uint8Array;
  result?: Exclude<ReadResult, { state: "pending" }>;
  pending?: Promise<ReadResult>;
  expires: number;
};

const IDLE_MS = 120_000;
const REQUEST_MS = 600_000;
const MAX_CHUNK_BYTES = 24_576;

function refuse(code: "conflict" | "forbidden" | "invalid" | "not_found", message: string): never {
  throw new experimental_PluginRpcRefusal({ code, message });
}

function requireMakosh({ experimental_caller: caller }: ExperimentalPluginRpcHandlerContext): void {
  if (caller.kind !== "plugin" || caller.pluginId !== "makosh-ai") {
    refuse("forbidden", "Only Makosh AI can access Account Pooler model RPC.");
  }
}

export function registerPoolModelApi(
  bb: BbPluginApi,
  send: (request: Request, provider: "claude" | "codex", route: string) => Promise<Response>,
): void {
  const streams = new Map<string, ModelStream>();
  function close(id: string, stream: ModelStream): void {
    streams.delete(id);
    stream.controller.abort();
    void stream.body?.cancel().catch(() => {});
  }
  const sweep = setInterval(() => {
    for (const [id, stream] of streams) {
      if (Date.now() >= stream.expires) close(id, stream);
    }
  }, 5_000);
  sweep.unref();
  bb.onDispose(() => {
    clearInterval(sweep);
    for (const [id, stream] of streams) close(id, stream);
  });

  async function next(stream: ModelStream): Promise<Exclude<ReadResult, { state: "pending" }>> {
    try {
      const response = await stream.reader;
      const status = response.status;
      const contentType = response.headers.get("content-type");
      stream.body ??= response.body?.getReader();
      const update = stream.remainder === undefined ? await stream.body?.read() : {
        done: false,
        value: stream.remainder,
      };
      if (!update || update.done) return { state: "done", status, contentType };
      const { value } = update;
      stream.remainder = value.length > MAX_CHUNK_BYTES ? value.subarray(MAX_CHUNK_BYTES) : undefined;
      return {
        state: "chunk",
        cursor: stream.cursor + 1,
        status,
        contentType,
        data: Buffer.from(value.subarray(0, MAX_CHUNK_BYTES)).toString("base64"),
      };
    } catch {
      return { state: "failed", message: "The pooled model request did not finish." };
    }
  }

  bb.rpc.register(contract, {
    "model-api.v1.start"({ owner, request }, context) {
      requireMakosh(context);
      context.experimental_signal.throwIfAborted();
      if (streams.size >= 64 || [...streams.values()].filter((stream) => stream.owner === owner).length >= 8) {
        refuse("conflict", "Too many open model streams.");
      }
      const { providerId, conversationId, anthropicBeta } = request;
      const { pool: provider, route } = providerEntry(providerId);
      const headers = new Headers({ "content-type": "application/json" });
      const body = { ...request.body };
      const affinity = conversationId === undefined ? undefined : createHash("sha256")
        .update(JSON.stringify([owner, conversationId])).digest("hex");
      if (provider === "codex") {
        body.store = false;
        body.stream = true;
        if (affinity) headers.set("thread-id", affinity);
      } else {
        headers.set("anthropic-version", "2023-06-01");
        if (anthropicBeta) headers.set("anthropic-beta", anthropicBeta);
        if (affinity) {
          const metadata = body.metadata;
          body.metadata = {
            ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
            user_id: JSON.stringify({ session_id: affinity }),
          };
        }
      }
      const payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > 8 * 1024 * 1024) refuse("invalid", "Model request exceeds 8 MiB.");
      const streamId = randomUUID();
      const controller = new AbortController();
      const httpRequest = new Request(`http://pool.internal${route}`, {
        body: payload,
        headers,
        method: "POST",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_MS)]),
      });
      const reader = send(httpRequest, provider, route).then((response) => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        return response;
      });
      void reader.catch(() => {});
      streams.set(streamId, {
        owner, controller, reader, cursor: 0, expires: Date.now() + IDLE_MS,
      });
      return { streamId };
    },
    async "model-api.v1.read"({ owner, streamId, cursor }, context) {
      requireMakosh(context);
      const stream = streams.get(streamId);
      if (!stream || stream.owner !== owner) refuse("not_found", "Model stream does not exist.");
      stream.expires = Date.now() + IDLE_MS;
      if (stream.result?.state === "chunk" && cursor === stream.cursor - 1) return stream.result;
      if (cursor !== stream.cursor) refuse("conflict", "Invalid model stream cursor.");
      if (stream.result?.state === "done" || stream.result?.state === "failed") return stream.result;
      stream.pending ??= next(stream).then((result) => {
        if (result.state === "chunk") stream.cursor = result.cursor;
        stream.result = result;
        stream.pending = undefined;
        return result;
      });
      const pending = stream.pending;
      const result = await new Promise<ReadResult>((resolve, reject) => {
        const signal = context.experimental_signal;
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve({ state: "pending" });
        }, 20_000);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        void pending.then((value) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          resolve(value);
        });
      });
      return result;
    },
    "model-api.v1.cancel"({ owner, streamId }, context) {
      requireMakosh(context);
      const stream = streams.get(streamId);
      if (!stream || stream.owner !== owner) return { cancelled: false };
      close(streamId, stream);
      return { cancelled: true };
    },
  });
}
