import { randomUUID } from "node:crypto";
import { experimental_PluginRpcCallError, type ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { CommanderError, CommanderErrorShape } from "../../core/errors.ts";
import { type Capability, type Endpoint, type Fingerprint } from "../../core/model.ts";
import { join, parent, type NameSegment, type ResourcePath } from "../../core/path.ts";
import { type FileProvider } from "../../core/provider.ts";
import { fromBig } from "../../core/size.ts";
import { type HostFsContract, type HostFsInput, type HostFsMethod, type HostFsOutput } from "../../core/wire/host-fs.ts";

export type HostFsClient = Pick<ExperimentalHostClient<typeof HostFsContract>, "call">;

const LONG_CALL_TIMEOUT_MS = 1_800_000;
const longCalls = new Set<HostFsMethod>(["copyWithin", "sha256", "writeCommit"]);
const mutations = new Set<HostFsMethod>(["writeCommit", "rename", "remove", "copyWithin", "mkdir"]);

type ReportedMethod = "writeCommit" | "copyWithin" | "rename" | "writeAbort";
type ResultNotice = {
  method: ReportedMethod;
  target: ResourcePath;
  atomicNoReplace?: false;
  orphanedTempPath?: ResourcePath;
};

export function translateHostFsError(method: HostFsMethod, error: unknown, signal?: AbortSignal): CommanderError {
  if (error instanceof Error && error.message.length <= 4096) {
    try {
      const shape = CommanderErrorShape.safeParse(JSON.parse(error.message));
      // The copy worker acknowledges cancellation after checking its staging and destination.
      if (shape.success && (shape.data.code !== "cancelled" || !mutations.has(method) || method === "copyWithin")) {
        return new CommanderError(shape.data.code, shape.data.message, shape.data.retryable);
      }
    } catch {
      // Transport failures may carry arbitrary diagnostics; keep them out of Commander.
    }
  }
  if (error instanceof experimental_PluginRpcCallError) {
    if (error.code === "invalid_input" || error.code === "invalid_json") {
      return new CommanderError("invalid_path", "Invalid host filesystem request");
    }
    if (error.code === "unknown_method") return new CommanderError("internal", "Host filesystem method is unavailable");
  }
  if (mutations.has(method)) return new CommanderError("outcome_unknown", "Host did not confirm the filesystem operation");
  if (signal?.aborted) return new CommanderError("cancelled", "Host filesystem call cancelled");
  if (method === "home") return new CommanderError("connection_failed", "Host filesystem is unavailable", true);
  return new CommanderError("connection_failed", "Host filesystem call failed");
}

export function createLocalProvider(
  endpoint: Endpoint, client: HostFsClient, options: { onResult?: (notice: ResultNotice) => void | Promise<void> } = {},
) {
  const hostId = endpoint.hostId;
  if (!hostId || endpoint.provider !== "local") throw new CommanderError("invalid_path", "Expected a local host endpoint");

  async function call<M extends HostFsMethod>(
    method: M, input: HostFsInput<M>, signal?: AbortSignal, hashesFile = false,
  ) {
    if (signal?.aborted) throw new CommanderError("cancelled", "Host filesystem call cancelled before dispatch");
    try {
      return await client.call(method, input, {
        hostId: hostId!, signal,
        ...(hashesFile || longCalls.has(method) ? { timeoutMs: LONG_CALL_TIMEOUT_MS } : {}),
      });
    } catch (error) {
      throw translateHostFsError(method, error, signal);
    }
  }

  async function notify(
    method: ReportedMethod, target: ResourcePath,
    { atomicNoReplace, orphanedTempPath }: Omit<ResultNotice, "method" | "target">,
  ): Promise<void> {
    if (atomicNoReplace === undefined && orphanedTempPath === undefined) return;
    try {
      await options.onResult?.({
        method, target,
        ...(atomicNoReplace === false ? { atomicNoReplace } : {}),
        ...(orphanedTempPath ? { orphanedTempPath } : {}),
      });
    } catch {
      // A consumer callback cannot change an already acknowledged filesystem outcome.
    }
  }

  async function fingerprintResult(
    method: "copyWithin" | "writeCommit", target: ResourcePath, result: HostFsOutput<"writeCommit">,
  ): Promise<Fingerprint> {
    const { atomicNoReplace, orphanedTempPath, ...fingerprint } = result;
    await notify(method, target, { atomicNoReplace, orphanedTempPath });
    return fingerprint;
  }

  const capabilities = new Set<Capability>([
    "list", "stat", "read", "write", "mkdir", "rename", "remove", "atomicReplace", "serverSideCopy", "seek", "checksum",
  ]);
  return {
    endpoint,
    capabilities,
    list: (path, opts, signal) => call("list", { path, ...opts }, signal),
    stat: (path, signal) => call("stat", { path }, signal),
    async read(path, offset, length, expect, signal) {
      const { b64 } = await call("read", { path, offset: fromBig(offset), length, expect }, signal);
      const bytes = Buffer.from(b64, "base64");
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    },
    async openWrite(target: ResourcePath, { tempName }: { tempName: NameSegment }, signal: AbortSignal) {
      const directory = parent(target);
      if (!directory) throw new CommanderError("permission_denied", "Cannot modify a filesystem root");
      const tempPath = join(directory, tempName);
      const { session } = await call("writeOpen", { target, tempName }, signal);
      return {
        tempPath,
        async write(offset, bytes, signal) {
          await call("writeChunk", { session, offset: fromBig(offset), b64: Buffer.from(bytes).toString("base64") }, signal);
        },
        async commit(opts, signal) {
          return fingerprintResult("writeCommit", target, await call("writeCommit", { session, ...opts }, signal));
        },
        async abort() { await notify("writeAbort", target, await call("writeAbort", { session })); },
      };
    },
    async mkdir(path, signal) { await call("mkdir", { path }, signal); },
    async rename(from, to, opts, signal) {
      const hashesFile = typeof opts.expectTarget === "object" && opts.expectTarget.sha256 !== undefined;
      await notify("rename", to, await call("rename", { from, to, ...opts }, signal, hashesFile));
    },
    async remove(path, opts, signal) {
      await call("remove", { path, ...opts }, signal, opts.expect?.sha256 !== undefined);
    },
    async copyWithin(from, to, opts, signal) {
      const operationId = randomUUID();
      try {
        return await fingerprintResult("copyWithin", to, await call("copyWithin", { from, to, ...opts, operationId }, signal));
      } catch (error) {
        if (signal.aborted && error instanceof CommanderError && error.code === "outcome_unknown") {
          const receipt = await call("copyCancelled", { operationId }, AbortSignal.timeout(5000)).catch(() => null);
          if (receipt?.confirmed) throw new CommanderError("cancelled", "Copy cancelled; destination and staging file are absent");
        }
        throw error;
      }
    },
    async sha256(path, signal) { return (await call("sha256", { path }, signal)).hex; },
  } satisfies FileProvider;
}
