import { experimental_PluginRpcRefusal, type ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { link, mkdir, opendir, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { CommanderError } from "../../../core/errors.ts";
import { type Entry } from "../../../core/model.ts";
import { parsePosix, ResourcePath } from "../../../core/path.ts";
import { type HostFsContract, type HostFsInput, type HostFsMethod, type HostFsOutput } from "../../../core/wire/host-fs.ts";
import { fsError, hasErrno } from "./errors.ts";
import { changed, describe, entryKind, forEachChunk, hashFile, matches, position, withRegularFile } from "./files.ts";
import { type NamePlatform } from "./names.ts";
import { childPath, decodeName, lstatOrNull, requireDirectory, resolvePath, sameNode } from "./paths.ts";
import { WriteSessions, type ScheduleExpiry } from "./writes.ts";

interface Context {
  signal: AbortSignal;
  lifecycle?: { signal: AbortSignal };
  experimental_retainWorker?: () => { dispose(): Promise<void> };
}

type Handler<M extends HostFsMethod> = (input: HostFsInput<M>, context: Context) => Promise<HostFsOutput<M>>;
type Handlers = { [M in HostFsMethod]: Handler<M> };

function indexFromCursor(cursor: string | null, version: string): number {
  if (!cursor) return 0;
  const match = /^(\d+):(\d+:\d+:-?\d+:-?\d+)$/u.exec(cursor);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new CommanderError("invalid_path", "Invalid directory cursor");
  }
  if (match[2] !== version) throw changed();
  return Number(match[1]);
}

function versionOf(stats: NonNullable<Awaited<ReturnType<typeof lstatOrNull>>>): string {
  return [stats.dev, stats.ino, stats.mtimeNs, stats.ctimeNs].join(":");
}

function refusal(error: unknown): experimental_PluginRpcRefusal {
  const shape = fsError(error).toShape();
  const code = shape.code === "not_found" ? "not_found"
    : shape.code === "permission_denied" ? "forbidden"
    : shape.code === "already_exists" || shape.code === "changed_since_plan" ? "conflict" : "invalid";
  // SDK refusals transport a message. Encode only the public, stack-free shape.
  return new experimental_PluginRpcRefusal({ code, message: JSON.stringify(shape) });
}

export function createHostFs(options: { platform?: NamePlatform; scheduleExpiry?: ScheduleExpiry } = {}) {
  const platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
  const writes = new WriteSessions(platform, options.scheduleExpiry);
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

  function handle<M extends HostFsMethod>(fn: Handler<M>, cleanup = false): Handler<M> {
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
          return await fn(input, {
            signal,
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

  const handlers: Handlers = {
    list: handle<"list">(async ({ path, cursor, limit }, { signal }) => {
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
          if (seen++ < start) continue;
          if (entries.length === limit) {
            more = true;
            break;
          }
          // Node returns Buffer names with encoding=buffer, despite its Dirent declaration.
          const name = decodeName(Buffer.from(item.name));
          const child = childPath(full, name);
          const childStats = await lstatOrNull(child);
          if (!childStats) throw changed();
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
    stat: handle<"stat">(async ({ path }) => {
      const resolved = await resolvePath(path, platform).catch((error) => {
        if (hasErrno(error, "ENOENT")) return null;
        throw error;
      });
      return resolved?.stats ? describe(resolved.full, path.segments.at(-1) ?? { t: "root" }, resolved.stats) : null;
    }),
    read: handle<"read">(async ({ path, offset, length, expect }, { signal }) => {
      const { full, stats } = await resolvePath(path, platform);
      return withRegularFile(full, stats, signal, async (file, opened) => {
        if (expect && !matches(opened, expect)) throw changed();
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, position(offset));
        return { b64: buffer.subarray(0, bytesRead).toString("base64") };
      });
    }),
    writeOpen: handle<"writeOpen">(({ target }, { signal, experimental_retainWorker }) =>
      writes.open(target, signal, experimental_retainWorker)),
    writeChunk: handle<"writeChunk">(async ({ session, offset, b64 }, { signal }) => {
      await writes.write(session, position(offset), Buffer.from(b64, "base64"), signal);
      return {};
    }),
    writeCommit: handle<"writeCommit">(({ session, replace, expectTarget }, { signal }) =>
      writes.commit(session, replace, expectTarget, signal)),
    writeAbort: handle<"writeAbort">(async ({ session }) => {
      await writes.abort(session);
      return {};
    }, true),
    mkdir: handle<"mkdir">(({ path }, { signal }) => writes.publish(async () => {
      const { full } = await resolvePath(path, platform, { target: true });
      signal.throwIfAborted();
      await mkdir(full);
      return {};
    })),
    rename: handle<"rename">(({ from, to, replace }, { signal }) => writes.publish(async () => {
      const source = await resolvePath(from, platform, { mutable: true });
      const target = await resolvePath(to, platform, { target: true });
      if (!source.stats) throw new CommanderError("not_found", "Source does not exist");
      if (!replace && target.stats) throw new CommanderError("already_exists", "Target exists");
      signal.throwIfAborted();
      if (!replace && source.stats.isFile()) {
        await link(source.full, target.full);
        try {
          await unlink(source.full);
        } catch {
          throw new CommanderError("outcome_unknown", "Both rename paths may exist");
        }
      } else {
        await rename(source.full, target.full);
      }
      return {};
    })),
    remove: handle<"remove">(({ path, kind }, { signal }) => writes.publish(async () => {
      const { full, stats } = await resolvePath(path, platform, { mutable: true });
      if (stats && entryKind(stats) !== kind) throw changed();
      signal.throwIfAborted();
      if (kind === "dir") await rmdir(full);
      else await unlink(full);
      return {};
    })),
    copyWithin: handle<"copyWithin">(async ({ from, to, replace, expectTarget }, { signal }) => {
      const source = await resolvePath(from, platform);
      return withRegularFile(source.full, source.stats, signal, async (file, opened) => {
        const { session } = await writes.open(to, signal);
        try {
          await forEachChunk(file, signal, (chunk, offset) => writes.write(session, offset, chunk, signal));
          if (!matches(await file.stat({ bigint: true }), {
            size: opened.size.toString(), mtimeNs: opened.mtimeNs.toString(),
          })) throw changed();
          return await writes.commit(session, replace, expectTarget, signal);
        } finally {
          await writes.abort(session);
        }
      });
    }),
    sha256: handle<"sha256">(async ({ path }, { signal }) => {
      const { full, stats } = await resolvePath(path, platform);
      return { hex: await withRegularFile(full, stats, signal, (file) => hashFile(file, signal)) };
    }),
    home: handle<"home">(async () => {
      const home = homedir();
      if (platform === "win32") {
        const absolute = win32.parse(home);
        const names = home.slice(absolute.root.length).split("\\").filter(Boolean);
        const path = ResourcePath.parse({ segments: [absolute.root.slice(0, 2), ...names].map((t) => ({ t })) });
        return { path, caseSensitive: false };
      }
      const path = parsePosix(home);
      const { parent, stats } = await resolvePath(path, platform);
      const name = path.segments.at(-1);
      if (!parent || !stats || !name || !("t" in name)) return { path, caseSensitive: process.platform !== "darwin" };
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
        throw refusal(error);
      }
    };
  }

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
    copyWithin: rpcHandler(handlers.copyWithin),
    sha256: rpcHandler(handlers.sha256),
    home: rpcHandler(handlers.home),
  };

  return { handlers, rpcHandlers, dispose };
}
