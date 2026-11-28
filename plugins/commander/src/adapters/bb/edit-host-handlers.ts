import { opendir } from "node:fs/promises";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { segmentKey } from "../../core/guards.ts";
import type { NameSegment } from "../../core/path.ts";
import { CommanderError } from "../../core/errors.ts";
import type { editHostSchemas } from "../../core/wire/edit.ts";
import { createEditPathPolicy } from "./edit-path-policy.ts";
import { hasErrno } from "./host-fs/errors.ts";
import { childPath, decodeName, lstatOrNull, recheckParent, resolvePath, sameNode } from "./host-fs/paths.ts";
import { createEditFiles } from "./edit-files.ts";

export function createEditHostHandlers(files = createEditFiles()): ExperimentalHostRpcHandlers<typeof editHostSchemas> {
  const handlers: ExperimentalHostRpcHandlers<typeof editHostSchemas> = {
    async editSourceIdentity({ path }, ctx) {
      const platform = process.platform === "win32" ? "win32" : "posix";
      const policy = await createEditPathPolicy(ctx.experimental_paths.dataDir, platform, ctx.signal);
      await policy.check(path);
      const resolved = await resolvePath(path, platform).catch((error) => {
        if (hasErrno(error, "ENOENT")) return null;
        throw error;
      });
      const requested = path.segments.at(-1);
      if (!resolved?.stats?.isFile() || !resolved.parent || !resolved.parentStats || !requested) return null;
      if (await policy.hidden(resolved.full, resolved.stats)) {
        throw new CommanderError("permission_denied", "Path is outside the agent's grant");
      }
      const exactKey = segmentKey(requested, true);
      const foldedKey = segmentKey(requested, false);
      const directory = await opendir(resolved.parent, platform === "win32" ? {} : { encoding: "buffer" as BufferEncoding });
      let exact: NameSegment | undefined;
      let folded: NameSegment | undefined;
      let ambiguous = false;
      try {
        for (;;) {
          ctx.signal.throwIfAborted();
          const item = await directory.read();
          if (!item) break;
          const name: NameSegment = platform === "win32" ? { t: item.name } : decodeName(Buffer.from(item.name));
          if (segmentKey(name, false) !== foldedKey) continue;
          const candidate = await lstatOrNull(childPath(resolved.parent, name));
          if (!candidate || !sameNode(candidate, resolved.stats)) continue;
          if (segmentKey(name, true) === exactKey) {
            exact = name;
            break;
          }
          ambiguous ||= folded !== undefined;
          folded = name;
        }
      } finally { await directory.close(); }
      const name = exact ?? (ambiguous ? undefined : folded);
      if (!name) return null;
      await recheckParent(resolved);
      const latest = await lstatOrNull(resolved.full);
      const listed = await lstatOrNull(childPath(resolved.parent, name));
      if (!latest?.isFile() || !listed?.isFile()
          || !sameNode(latest, resolved.stats) || !sameNode(listed, resolved.stats)) return null;
      return {
        dev: latest.dev.toString(), ino: latest.ino.toString(), name,
        parentDev: resolved.parentStats.dev.toString(), parentIno: resolved.parentStats.ino.toString(),
      };
    },
    async editCreate(input, ctx) {
      return { path: await files.create(ctx.experimental_paths.dataDir, input.sessionId, input.size) };
    },
    async editRoute(input, ctx) {
      return { path: await files.route(ctx.experimental_paths.dataDir, input.sessionId, input.revision, input.name) };
    },
    editReadChunk(input, ctx) {
      return files.readChunk(ctx.experimental_paths.dataDir, input.sessionId, input.source, input.offset, input.length);
    },
    async editWriteChunk(input, ctx) {
      await files.writeChunk(ctx.experimental_paths.dataDir, input.sessionId, input.baseRevision, input.offset, Buffer.from(input.bytes, "base64"));
      return {};
    },
    async editCommitRevision(input, ctx) {
      return { revision: await files.commitRevision(ctx.experimental_paths.dataDir, input.sessionId, input.baseRevision, input.sha256, input.initial) };
    },
    editSnapshot(input, ctx) {
      return files.snapshot(ctx.experimental_paths.dataDir, input.sessionId, input.revision, input.snapshotId);
    },
    editInspectSnapshot(input, ctx) {
      return files.inspectSnapshot(ctx.experimental_paths.dataDir, input.sessionId, input.snapshotId);
    },
    async editDelete(input, ctx) {
      await files.delete(ctx.experimental_paths.dataDir, input.sessionId, input.source);
      return {};
    },
    async editDiscardUpload(input, ctx) {
      await files.discardStaleUpload(ctx.experimental_paths.dataDir, input.sessionId, input.baseRevision);
      return {};
    },
    async editSweep(input, ctx) {
      await files.sweep(ctx.experimental_paths.dataDir, input.held);
      return {};
    },
  };

  return Object.fromEntries(Object.entries(handlers).map(([method, run]) => [
    method, async (input: never, ctx: Parameters<typeof run>[1]) => {
      try {
        ctx.signal.throwIfAborted();
        if (!ctx.experimental_paths.dataDir) throw new CommanderError("unsupported", "Каталог редактора BB недоступен");
        return await run(input, ctx);
      } catch (error) {
        const failure = error instanceof CommanderError ? error : new CommanderError("internal", "Операция с копией не выполнена");
        throw new Error(JSON.stringify(failure.toShape()));
      }
    },
  ])) as ExperimentalHostRpcHandlers<typeof editHostSchemas>;
}
