import {
  defineRpcContract,
  experimental_PluginRpcCallError,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type ExperimentalPluginRpcHandlerContext,
} from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  cancelOutput, errorReasons, handle, modelsInput, modelsOutput, parseReason, providerCatalog,
  providersInput, providersOutput, readInput, readOutput, reasonMessage, startInput,
  type ErrorReason, type RefusalCode,
} from "./src/core/contract.js";

const contract = defineRpcContract({
  "ai.v1.providers": { input: providersInput, output: providersOutput },
  "ai.v1.models": { input: modelsInput, output: modelsOutput },
  "ai.v1.start": { input: startInput, output: handle },
  "ai.v1.read": { input: readInput, output: readOutput },
  "ai.v1.cancel": { input: handle, output: cancelOutput },
});

function refuse(reason: ErrorReason, text: string): never {
  throw new experimental_PluginRpcRefusal({ code: errorReasons[reason], message: reasonMessage(reason, text) });
}

function requirePlugin({ experimental_caller: caller }: ExperimentalPluginRpcHandlerContext): string {
  if (caller.kind !== "plugin") refuse("forbidden_caller", "Only BB plugin servers can call Makosh AI.");
  return caller.pluginId;
}

// Known Account Pooler bridge messages. The deployed bridge sends them
// without a reason prefix, so Makosh AI classifies them here.
const bridgeReasons: Record<string, ErrorReason> = {
  "Too many open model streams.": "busy",
  "Model stream does not exist.": "stream_lost",
  "Invalid model stream cursor.": "bad_cursor",
  "Model request exceeds 8 MiB.": "too_large",
};

function poolRefusal(error: experimental_PluginRpcCallError): experimental_PluginRpcRefusal | undefined {
  if (error.code === "unknown_method") {
    return new experimental_PluginRpcRefusal({
      code: errorReasons.bridge_missing,
      message: reasonMessage("bridge_missing",
        "Account Pooler model RPC is unavailable. The Makosh bridge is required."),
    });
  }
  if (error.code !== "not_found" && error.code !== "conflict" && error.code !== "invalid") return undefined;
  const code: RefusalCode = error.code;
  if (parseReason(error.message)) return new experimental_PluginRpcRefusal({ code, message: error.message });
  const known = bridgeReasons[error.message];
  if (known && errorReasons[known] === code) {
    return new experimental_PluginRpcRefusal({ code, message: reasonMessage(known, error.message) });
  }
  if (code === "not_found") {
    return new experimental_PluginRpcRefusal({
      code,
      message: reasonMessage("pool_missing", `Account Pooler is not available. ${error.message}`),
    });
  }
  return new experimental_PluginRpcRefusal({ code, message: error.message });
}

async function fromPool<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof experimental_PluginRpcCallError) throw poolRefusal(error) ?? error;
    throw error;
  }
}

type Availability = { available: true } | { available: false; reason: "bridge_missing" | "pool_missing" };

// One no-op bridge call: cancelling a stream ID nobody owns. It shows whether
// Account Pooler and its model RPC are loaded; account readiness for each
// provider is checked by the pool when a stream starts.
async function probeBridge(bb: BbPluginApi, owner: string, signal: AbortSignal): Promise<Availability> {
  try {
    await bb.sdk.plugins.callRpc({
      pluginId: "account-pool",
      method: "model-api.v1.cancel",
      input: { streamId: crypto.randomUUID(), owner },
      outputSchema: cancelOutput,
      signal,
    });
  } catch (error) {
    if (error instanceof experimental_PluginRpcCallError) {
      if (error.code === "unknown_method") return { available: false, reason: "bridge_missing" };
      if (error.code === "not_found") return { available: false, reason: "pool_missing" };
    }
    signal.throwIfAborted();
  }
  return { available: true };
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.rpc.register(contract, {
    async "ai.v1.providers"(_input, context): Promise<z.infer<typeof providersOutput>> {
      const owner = requirePlugin(context);
      const availability = await probeBridge(bb, owner, context.experimental_signal);
      return {
        providers: providerCatalog.map(({ id, displayName, apiFormat }) => ({
          id, displayName, apiFormat, ...availability,
        })),
      };
    },
    async "ai.v1.models"({ providerId, projectId }, context) {
      requirePlugin(context);
      const { models } = await bb.sdk.providers.models({
        providerId,
        ...(projectId === undefined ? {} : { projectId }),
        signal: context.experimental_signal,
      });
      return { models: models.map(({ model, displayName }) => ({ model, displayName })) };
    },
    "ai.v1.start"(request, context) {
      return fromPool(bb.sdk.plugins.callRpc({
        pluginId: "account-pool",
        method: "model-api.v1.start",
        input: { request, owner: requirePlugin(context) },
        outputSchema: handle,
        signal: context.experimental_signal,
      }));
    },
    "ai.v1.read"(request, context) {
      return fromPool(bb.sdk.plugins.callRpc({
        pluginId: "account-pool",
        method: "model-api.v1.read",
        input: { ...request, owner: requirePlugin(context) },
        outputSchema: readOutput,
        signal: context.experimental_signal,
      }));
    },
    "ai.v1.cancel"(request, context) {
      return fromPool(bb.sdk.plugins.callRpc({
        pluginId: "account-pool",
        method: "model-api.v1.cancel",
        input: { ...request, owner: requirePlugin(context) },
        outputSchema: cancelOutput,
        signal: context.experimental_signal,
      }));
    },
  }, {
    experimental_discoverable: true,
    experimental_description: "Make provider API requests through Account Pooler.",
  });
}
