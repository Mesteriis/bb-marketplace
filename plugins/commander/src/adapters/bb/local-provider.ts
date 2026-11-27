import { type ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { CommanderError, CommanderErrorShape } from "../../core/errors.ts";
import { type Capability, type Endpoint, type Fingerprint } from "../../core/model.ts";
import { join, parent, type ResourcePath } from "../../core/path.ts";
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

function translate(method: HostFsMethod, error: unknown, signal?: AbortSignal): CommanderError {
  if (error instanceof Error && error.message.length <= 4096) {
    try {
      const shape = CommanderErrorShape.safeParse(JSON.parse(error.message));
      if (shape.success) return new CommanderError(shape.data.code, shape.data.message, shape.data.retryable);
    } catch {
      // Transport failures may carry arbitrary diagnostics; keep them out of Commander.
    }
  }
  if (signal?.aborted) return new CommanderError("cancelled", "Host filesystem call cancelled");
  if (mutations.has(method)) return new CommanderError("outcome_unknown", "Host did not confirm the filesystem operation");
  return new CommanderError("connection_failed", "Host filesystem call failed");
}

export function createLocalProvider(
  endpoint: Endpoint, client: HostFsClient, options: { onResult?: (notice: ResultNotice) => void | Promise<void> } = {},
) {
  const hostId = endpoint.hostId;
  if (!hostId || endpoint.provider !== "local") throw new CommanderError("invalid_path", "Expected a local host endpoint");

  async function call<M extends HostFsMethod>(method: M, input: HostFsInput<M>, signal?: AbortSignal) {
    try {
      signal?.throwIfAborted();
      return await client.call(method, input, {
        hostId: hostId!, signal,
        ...(longCalls.has(method) ? { timeoutMs: LONG_CALL_TIMEOUT_MS } : {}),
      });
    } catch (error) {
      throw translate(method, error, signal);
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
    async openWrite(target: ResourcePath, signal: AbortSignal) {
      const directory = parent(target);
      if (!directory) throw new CommanderError("permission_denied", "Cannot modify a filesystem root");
      const { session, tempName } = await call("writeOpen", { target }, signal);
      return {
        tempPath: join(directory, tempName),
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
      await notify("rename", to, await call("rename", { from, to, ...opts }, signal));
    },
    async remove(path, opts, signal) { await call("remove", { path, ...opts }, signal); },
    async copyWithin(from, to, opts, signal) {
      return fingerprintResult("copyWithin", to, await call("copyWithin", { from, to, ...opts }, signal));
    },
    async sha256(path, signal) { return (await call("sha256", { path }, signal)).hex; },
  } satisfies Omit<FileProvider, "openWrite"> & {
    openWrite(target: ResourcePath, signal: AbortSignal): Promise<
      Awaited<ReturnType<FileProvider["openWrite"]>> & { readonly tempPath: ResourcePath }
    >;
  };
}
