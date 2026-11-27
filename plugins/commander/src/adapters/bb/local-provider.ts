import { type ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { CommanderError, CommanderErrorShape } from "../../core/errors.ts";
import { type Capability, type Endpoint } from "../../core/model.ts";
import { join, parent, type ResourcePath } from "../../core/path.ts";
import { type FileProvider } from "../../core/provider.ts";
import { fromBig } from "../../core/size.ts";
import { type HostFsContract, type HostFsInput, type HostFsMethod } from "../../core/wire/host-fs.ts";

export type HostFsClient = Pick<ExperimentalHostClient<typeof HostFsContract>, "call">;

function translate(error: unknown, signal?: AbortSignal): CommanderError {
  if (error instanceof Error && error.message.length <= 4096) {
    try {
      const shape = CommanderErrorShape.safeParse(JSON.parse(error.message));
      if (shape.success) return new CommanderError(shape.data.code, shape.data.message, shape.data.retryable);
    } catch {
      // Transport failures may carry arbitrary diagnostics; keep them out of Commander.
    }
  }
  if (signal?.aborted) return new CommanderError("cancelled", "Host filesystem call cancelled");
  return new CommanderError("connection_failed", "Host filesystem call failed");
}

export function createLocalProvider(endpoint: Endpoint, client: HostFsClient) {
  const hostId = endpoint.hostId;
  if (!hostId || endpoint.provider !== "local") throw new CommanderError("invalid_path", "Expected a local host endpoint");

  async function call<M extends HostFsMethod>(method: M, input: HostFsInput<M>, signal?: AbortSignal) {
    try {
      signal?.throwIfAborted();
      return await client.call(method, input, { hostId: hostId!, signal });
    } catch (error) {
      throw translate(error, signal);
    }
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
        commit: (opts, signal) => call("writeCommit", { session, ...opts }, signal),
        async abort() { await call("writeAbort", { session }); },
      };
    },
    async mkdir(path, signal) { await call("mkdir", { path }, signal); },
    async rename(from, to, opts, signal) { await call("rename", { from, to, ...opts }, signal); },
    async remove(path, opts, signal) { await call("remove", { path, ...opts }, signal); },
    copyWithin: (from, to, opts, signal) => call("copyWithin", { from, to, ...opts }, signal),
    async sha256(path, signal) { return (await call("sha256", { path }, signal)).hex; },
  } satisfies Omit<FileProvider, "openWrite"> & {
    openWrite(target: ResourcePath, signal: AbortSignal): Promise<
      Awaited<ReturnType<FileProvider["openWrite"]>> & { readonly tempPath: ResourcePath }
    >;
  };
}
