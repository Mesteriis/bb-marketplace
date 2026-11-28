/**
 * Known limits
 * Node has no openat/renameat2 API. Intermediate components can change between
 * lstat and an operation. Parent, leaf and descriptor checks narrow those windows.
 * Conditional mutations are serialized within this worker. External
 * processes can still change an entry between its final version check and
 * rename, unlink or rmdir.
 * POSIX directory/symlink rename without replacement uses a final absence check
 * followed by rename. That sequence can race with external target creation.
 * Filesystems that reject hard links use the same fallback and report it.
 * BB caps each host RPC at 30 minutes. copyWithin and sha256 may time out
 * for very large files.
 */
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { link, mkdir, opendir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { CommanderError } from "../../../core/errors.ts";
import { type Entry } from "../../../core/model.ts";
import { parsePosix, type ResourcePath } from "../../../core/path.ts";
import { type HostFsContract, type HostFsInput, type HostFsMethod, type HostFsOutput } from "../../../core/wire/host-fs.ts";
import { fsError, hasErrno, linkUnavailable } from "./errors.ts";
import { changed, describe, entryKind, forEachChunk, hashFile, matches, position, requireVersion, verifyVersionHash, withRegularFile,
  type ExpectedVersion } from "./files.ts";
import { validateTargetName, type NamePlatform } from "./names.ts";
import { childPath, decodeName, lstatOrNull, parseWindowsPath, recheckParent, requireDirectory, resolvePath, sameNode } from "./paths.ts";
// S16: the ordinary filesystem routes exclude the editor data on this host.
import { createEditPathPolicy } from "../edit-path-policy.ts";
import { join, parent } from "../../../core/path.ts";
import { WriteSessions, type WriteOptions } from "./writes.ts";

interface Context {
  signal: AbortSignal;
  lifecycle?: { signal: AbortSignal };
  experimental_retainWorker?: () => { dispose(): Promise<void> };
  // S16
  experimental_paths?: { dataDir: string };
  editPaths?: Awaited<ReturnType<typeof createEditPathPolicy>>;
}

type Handler<M extends HostFsMethod> = (input: HostFsInput<M>, context: Context) => Promise<HostFsOutput<M>>;
type Handlers = { [M in HostFsMethod]: Handler<M> };

function indexFromCursor(cursor: string | null, version: string): number {
  if (!cursor) return 0;
  const match = /^(\d+):(\d+:\d+)$/u.exec(cursor);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new CommanderError("invalid_path", "Invalid directory cursor");
  }
  if (match[2] !== version) throw changed();
  return Number(match[1]);
}

function versionOf(stats: NonNullable<Awaited<ReturnType<typeof lstatOrNull>>>): string {
  return [stats.dev, stats.ino].join(":");
}

export function createHostFs(options: WriteOptions & { platform?: NamePlatform } = {}) {
  const platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
  const writes = new WriteSessions(platform, options);
  // BB can replace the copy reply with AbortError. Keep recent proofs in this worker.
  const cancelledCopies = new Set<string>();
  const runningCopies = new Set<string>();
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let lifecycle: AbortSignal | undefined;
  let disposing: Promise<void> | undefined;

  function dispose(): Promise<void> {
    if (disposing) return disposing;
    shutdown.abort();
    lifecycle?.removeEventListener("abort", onShutdown);
    disposing = (async () => {
      await Promise.allSettled(pending);
      await writes.dispose().catch((error) => { throw fsError(error); });
    })();
    return disposing;
  }

  function onShutdown(): void {
    void dispose().catch(() => {});
  }

  function handle<M extends HostFsMethod>(fn: Handler<M>, cleanup = false, checkPaths = true): Handler<M> {
    return (input, context) => {
      if (!lifecycle && context.lifecycle) {
        lifecycle = context.lifecycle.signal;
        lifecycle.addEventListener("abort", onShutdown, { once: true });
        if (lifecycle.aborted) onShutdown();
      }
      const signal = AbortSignal.any([context.signal, shutdown.signal]);
      const task = (async () => {
        try {
          if (!cleanup) signal.throwIfAborted();
          // S16: BB supplies the private root via host context only.
          const editPaths = checkPaths && context.experimental_paths?.dataDir
            ? await createEditPathPolicy(context.experimental_paths.dataDir, platform, signal) : undefined;
          return await fn(input, {
            signal, editPaths,
            experimental_retainWorker: context.experimental_retainWorker?.bind(context),
          });
        } catch (error) {
          throw fsError(error, signal);
        }
      })();
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    };
  }

  async function resolveVersionedPath(
    path: ResourcePath, expect: ExpectedVersion, options: Parameters<typeof resolvePath>[2],
  ) {
    try {
      return await resolvePath(path, platform, options);
    } catch (error) {
      if (expect && expect !== "absent" && hasErrno(error, "ENOENT")) throw changed();
      throw error;
    }
  }

  const handlers: Handlers = {
    list: handle<"list">(async ({ path, cursor, limit }, { signal, editPaths }) => {
      await editPaths?.check(path);
      const { full, stats } = await resolvePath(path, platform);
      if (!stats) {
        if (cursor !== null) throw changed();
        throw new CommanderError("not_found", "Directory does not exist");
      }
      requireDirectory(stats);
      const version = versionOf(stats);
      const start = indexFromCursor(cursor, version);
      const entries: Entry[] = [];
      let seen = 0;
      let responseBytes = 0;
      let more = false;
      // Node accepts buffer encoding at runtime for byte-exact dirent names.
      const directory = await opendir(full, { encoding: "buffer" as BufferEncoding });
      try {
        while (true) {
          signal.throwIfAborted();
          const item = await directory.read();
          if (!item) break;
          if (!editPaths && seen++ < start) continue;
          // Node returns Buffer names with encoding=buffer, despite its Dirent declaration.
          const name = decodeName(Buffer.from(item.name));
          const child = childPath(full, name);
          const childStats = await lstatOrNull(child);
          if (!childStats) throw changed();
          // S16: omit private entries before counting the cursor or page limit.
          if (editPaths && (await editPaths.hidden(child, childStats) || seen++ < start)) continue;
          if (entries.length === limit) {
            more = true;
            break;
          }
          const entry = await describe(child, name, childStats);
          responseBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
          // Leave space for the cursor and RPC envelope under BB's 8 MiB limit.
          if (responseBytes > 7 * 1024 * 1024) {
            more = true;
            break;
          }
          entries.push(entry);
        }
        const current = await lstatOrNull(full);
        if (!current || versionOf(current) !== version) throw changed();
      } finally {
        await directory.close();
      }
      return { entries, cursor: more ? (start + entries.length) + ":" + version : null };
    }),
    stat: handle<"stat">(async ({ path }, { editPaths }) => {
      await editPaths?.check(path);
      const resolved = await resolvePath(path, platform).catch((error) => {
        if (hasErrno(error, "ENOENT")) return null;
        throw error;
      });
      if (resolved?.stats && await editPaths?.hidden(resolved.full, resolved.stats)) {
        throw new CommanderError("permission_denied", "Path is outside the agent's grant");
      }
      return resolved?.stats ? describe(resolved.full, path.segments.at(-1) ?? { t: "root" }, resolved.stats) : null;
    }),
    read: handle<"read">(async ({ path, offset, length, expect }, { signal, editPaths }) => {
      await editPaths?.check(path);
      const { full, stats } = await resolvePath(path, platform);
      return withRegularFile(full, stats, signal, async (file, opened) => {
        if (await editPaths?.hidden(full, opened)) throw new CommanderError("permission_denied", "Path is outside the agent's grant");
        if (expect && !matches(opened, expect)) throw changed();
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, position(offset));
        return { b64: buffer.subarray(0, bytesRead).toString("base64") };
      });
    }),
    writeOpen: handle<"writeOpen">(async ({ target, tempName }, { signal, experimental_retainWorker, editPaths }) => {
      await editPaths?.check(target);
      const directory = parent(target);
      if (directory) await editPaths?.check(join(directory, tempName));
      return writes.open(target, tempName, signal, experimental_retainWorker);
    }),
    writeChunk: handle<"writeChunk">(async ({ session, offset, b64 }, { signal }) => {
      await writes.write(session, position(offset), Buffer.from(b64, "base64"), signal);
      return {};
    }, false, false),
    writeCommit: handle<"writeCommit">(({ session, replace, expectTarget }, { signal }) =>
      writes.commit(session, replace, expectTarget, signal), false, false),
    writeAbort: handle<"writeAbort">(({ session }) => writes.abort(session), true, false),
    mkdir: handle<"mkdir">(({ path }, { signal, editPaths }) => writes.publish(async () => {
      await editPaths?.check(path);
      const target = await resolvePath(path, platform, { target: true });
      await recheckParent(target);
      signal.throwIfAborted();
      await mkdir(target.full);
      return {};
    })),
    rename: handle<"rename">(async ({ from, to, replace, expectTarget }, { signal, editPaths }) => {
      await editPaths?.check(from, true);
      await editPaths?.check(to, true);
      const name = to.segments.at(-1);
      if (name) validateTargetName(name, platform);
      // Inspect the leaf with lstat so a newly occupied target reports a version mismatch.
      const resolveTarget = () => resolveVersionedPath(to, expectTarget, { mutable: true });
      const hashed = await verifyVersionHash(resolveTarget, expectTarget, signal, options.hashTarget);
      const noReplace = !replace || expectTarget === "absent";

      return writes.publish(async () => {
        const source = await resolvePath(from, platform, { mutable: true });
        const target = await resolveTarget();
        if (!source.stats) throw new CommanderError("not_found", "Source does not exist");

        const checkTarget = async () => {
          const current = await lstatOrNull(target.full);
          requireVersion(current, expectTarget, hashed);
          if (current?.isSymbolicLink()) throw new CommanderError("permission_denied", "Symbolic link at target");
          if (noReplace && current) throw new CommanderError("already_exists", "Target exists");
        };

        if (noReplace && source.stats.isFile()) {
          await recheckParent(source);
          await recheckParent(target);
          await checkTarget();
          signal.throwIfAborted();
          let linked = false;
          try {
            await (options.link ?? link)(source.full, target.full);
            linked = true;
          } catch (error) {
            if (expectTarget === "absent" && hasErrno(error, "EEXIST")) throw changed();
            if (!linkUnavailable(error)) throw error;
          }
          if (linked) {
            try {
              await recheckParent(source);
              await recheckParent(target);
              const bound = await lstatOrNull(target.full);
              const current = await lstatOrNull(source.full);
              if (!bound || !current || !sameNode(bound, source.stats) || !sameNode(current, bound)) throw changed();
              await (options.unlink ?? unlink)(source.full);
            } catch {
              throw new CommanderError("outcome_unknown", "Rename could not confirm removal of the original source");
            }
            return {};
          }
        }

        // Recheck after a failed link. The rename syscall itself has no no-clobber flag on this API.
        await recheckParent(source);
        await recheckParent(target);
        const current = await lstatOrNull(source.full);
        if (!current || !sameNode(current, source.stats)) throw changed();
        await checkTarget();
        signal.throwIfAborted();
        await rename(source.full, target.full);
        return noReplace ? { atomicNoReplace: false as const } : {};
      });
    }),
    remove: handle<"remove">(async ({ path, kind, expect }, { signal, editPaths }) => {
      await editPaths?.check(path, true);
      const resolveEntry = () => resolveVersionedPath(path, expect, { mutable: true });
      const hashed = await verifyVersionHash(resolveEntry, expect, signal, options.hashTarget);
      return writes.publish(async () => {
        const resolved = await resolveEntry();
        const { full, stats } = resolved;
        await recheckParent(resolved);
        const current = await lstatOrNull(full);
        requireVersion(current, expect, hashed);
        if (current && (!stats || !sameNode(current, stats) || entryKind(current) !== kind)) throw changed();
        signal.throwIfAborted();
        if (kind === "dir") await rmdir(full);
        else await unlink(full);
        return {};
      });
    }),
    copyWithin: handle<"copyWithin">(async ({ from, to, replace, expectTarget, operationId }, { signal, editPaths }) => {
      await editPaths?.check(from);
      await editPaths?.check(to);
      const source = await resolvePath(from, platform);
      return withRegularFile(source.full, source.stats, signal, async (file, opened) => {
        if (await editPaths?.hidden(source.full, opened)) throw new CommanderError("permission_denied", "Path is outside the agent's grant");
        const { session, tempName } = await writes.open(to, undefined, signal).catch((error) => {
          if (signal.aborted) throw new CommanderError("outcome_unknown", "Copy staging could not be confirmed");
          throw error;
        });
        try {
          await forEachChunk(file, signal, (chunk, offset) => writes.write(session, offset, chunk, signal));
          if (!matches(await file.stat({ bigint: true }), {
            size: opened.size.toString(), mtimeNs: opened.mtimeNs.toString(),
          })) throw changed();
          return await writes.commit(session, replace, expectTarget, signal);
        } catch (error) {
          const cleanup = await writes.abort(session);
          if (cleanup.orphanedTempPath) {
            throw new CommanderError("outcome_unknown", "Copy staging cleanup could not be confirmed");
          }
          if (signal.aborted || fsError(error).code === "cancelled") {
            const absent = await resolvePath(to, platform).then(async (target) => {
              if (target.stats || !target.parent) return false;
              const staging = await lstatOrNull(childPath(target.parent, tempName));
              await recheckParent(target);
              return staging === null;
            }).catch(() => false);
            if (!absent) throw new CommanderError("outcome_unknown", "Copy destination or staging could not be confirmed absent");
            if (operationId) {
              cancelledCopies.add(operationId);
              if (cancelledCopies.size > 128) cancelledCopies.delete(cancelledCopies.values().next().value!);
            }
            throw new CommanderError("cancelled", "Copy cancelled; destination and staging file are absent");
          }
          throw error;
        }
      });
    }),
    copyCancelled: handle<"copyCancelled">(async ({ operationId }) => ({
      status: cancelledCopies.delete(operationId) ? "confirmed" : runningCopies.has(operationId) ? "pending" : "missing",
    }), false, false),
    sha256: handle<"sha256">(async ({ path }, { signal, editPaths }) => {
      await editPaths?.check(path);
      const { full, stats } = await resolvePath(path, platform);
      return { hex: await withRegularFile(full, stats, signal, async (file, opened) => {
        if (await editPaths?.hidden(full, opened)) throw new CommanderError("permission_denied", "Path is outside the agent's grant");
        return hashFile(file, signal);
      }) };
    }),
    home: handle<"home">(async () => {
      const home = await realpath(homedir()).catch((error) => {
        throw new CommanderError(fsError(error).code, "Could not resolve the host home directory");
      });
      const path = platform === "win32" ? parseWindowsPath(home) : parsePosix(home);
      const { parent, stats } = await resolvePath(path, platform);
      if (!stats) throw new CommanderError("not_found", "Host home directory does not exist");
      requireDirectory(stats);
      if (platform === "win32") return { path, caseSensitive: false };
      const name = path.segments.at(-1);
      if (!parent || !name || !("t" in name)) return { path, caseSensitive: process.platform !== "darwin" };
      const toggled = name.t.replace(/[a-z]/iu, (letter) =>
        letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
      const alias = toggled === name.t ? null : await lstatOrNull(childPath(parent, { t: toggled }));
      return { path, caseSensitive: toggled === name.t ? process.platform !== "darwin" : !alias || !sameNode(stats, alias) };
    }),
  };

  function rpcHandler<I, O>(fn: (input: I, context: Context) => Promise<O>) {
    return async (input: I, context: Context): Promise<O> => {
      try {
        return await fn(input, context);
      } catch (error) {
        // The host worker transports the message of a plain Error.
        throw new Error(JSON.stringify(fsError(error).toShape()));
      }
    };
  }

  const copyWithinRpc = rpcHandler(handlers.copyWithin);
  const rpcHandlers: ExperimentalHostRpcHandlers<typeof HostFsContract> = {
    list: rpcHandler(handlers.list),
    stat: rpcHandler(handlers.stat),
    read: rpcHandler(handlers.read),
    writeOpen: rpcHandler(handlers.writeOpen),
    writeChunk: rpcHandler(handlers.writeChunk),
    writeCommit: rpcHandler(handlers.writeCommit),
    writeAbort: rpcHandler(handlers.writeAbort),
    mkdir: rpcHandler(handlers.mkdir),
    rename: rpcHandler(handlers.rename),
    remove: rpcHandler(handlers.remove),
    async copyWithin(input, context) {
      const { operationId } = input;
      if (!operationId) return copyWithinRpc(input, context);
      cancelledCopies.delete(operationId);
      runningCopies.add(operationId);
      try {
        return await copyWithinRpc(input, context);
      } catch (error) {
        if (cancelledCopies.has(operationId)) throw new Error(JSON.stringify({ copyCancelled: operationId }));
        throw error;
      } finally {
        runningCopies.delete(operationId);
      }
    },
    copyCancelled: rpcHandler(handlers.copyCancelled),
    sha256: rpcHandler(handlers.sha256),
    home: rpcHandler(handlers.home),
  };

  return { handlers, rpcHandlers, dispose };
}
