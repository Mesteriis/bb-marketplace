// BB agent threads for Mail (slice 3g): start a thread with text Mail built
// (bb-text.ts) and an optional uploaded attachment, queue a message into a
// thread without interrupting a turn, read a thread's result, list threads,
// read a thread's storage files (inside its storage root only), upload a
// project attachment (a patch for a worktree thread) and read a project's
// default permission mode. The SDK shapes are the installed declarations'
// (spec resolution 7): text items carry `mentions: []`, send passes `mode`,
// and storage `limit` is a string. Errors carry codes only.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { underGit, withinTree } from "../../core/project-paths.ts";
import {
  BbPortError,
  type BbEnvironment,
  type BbFileBytes,
  type BbInputItem,
  type BbPermissionMode,
  type BbThreadInfo,
  type BbThreads,
  type WorkingTree,
} from "../../core/ports.ts";

/** threads.list takes at most this many ids a call. */
const THREAD_IDS_PER_CALL = 200;

type ThreadsSdk = Pick<BbPluginApi["sdk"], "threads" | "projects" | "files">;

/** A fresh managed worktree on the project's default branch (patch hand-off, Start rules). */
export function worktreeEnvironment(tree: WorkingTree): BbEnvironment {
  return { type: "host", hostId: tree.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } };
}

/** The project's own default environment (threads the owner starts from a mail). */
export function projectDefaultEnvironment(): BbEnvironment {
  return { type: "project-default" };
}

function textItem(text: string) {
  return { type: "text" as const, text, mentions: [] };
}

function isoOf(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function createBbThreads(sdk: ThreadsSdk): BbThreads {
  type Listed = Awaited<ReturnType<ThreadsSdk["threads"]["list"]>>[number];
  const info = (thread: Listed): BbThreadInfo => ({
    id: thread.id,
    title: thread.title ?? thread.titleFallback ?? null,
    projectId: thread.projectId ?? null,
    archived: thread.archivedAt !== null,
    updatedAt: isoOf(thread.updatedAt),
  });

  return {
    async spawn(args) {
      const thread = await sdk.threads.spawn({
        projectId: args.projectId,
        environment: args.environment,
        title: args.title,
        input: [textItem(args.prompt), ...(args.extraInput ?? [])],
        pluginMetadata: args.pluginMetadata as Parameters<ThreadsSdk["threads"]["spawn"]>[0]["pluginMetadata"],
        ...(args.permissionMode === undefined ? {} : { permissionMode: args.permissionMode }),
      });
      return { threadId: thread.id };
    },

    async send(threadId, text) {
      await sdk.threads.send({ threadId, input: [textItem(text)], mode: "queue-if-active" });
    },

    async output(threadId) {
      return (await sdk.threads.output({ threadId })).output;
    },

    async list(query) {
      if ("threadIds" in query) {
        const ids = [...new Set(query.threadIds)];
        const out: BbThreadInfo[] = [];
        for (let i = 0; i < ids.length; i += THREAD_IDS_PER_CALL) {
          const threadIds = ids.slice(i, i + THREAD_IDS_PER_CALL);
          // Live and archived ones; deleted and unknown ids are left out by BB.
          const [live, archived] = await Promise.all([
            sdk.threads.list({ threadIds }),
            sdk.threads.list({ threadIds, archived: true }),
          ]);
          const seen = new Set<string>();
          for (const thread of [...live, ...archived]) {
            if (seen.has(thread.id)) continue;
            seen.add(thread.id);
            out.push(info(thread));
          }
        }
        return out;
      }
      return (await sdk.threads.list({ projectId: query.projectId, limit: query.limit })).map(info);
    },

    async storageFiles(threadId, query, limit) {
      const result = await sdk.threads.storageFiles({ threadId, query, limit: String(limit) });
      return {
        files: result.files.filter((file) => !underGit(file.path)).map((file) => ({ name: file.name, path: file.path })),
        truncated: result.truncated,
      };
    },

    async readStorageFile(threadId, path): Promise<BbFileBytes> {
      const location = await sdk.threads.storageLocation({ threadId });
      const root = location.storageRootPath.replace(/\/+$/, "");
      const absolute = path.startsWith("/") ? path : `${root}/${path}`;
      if (path.includes("\\") || underGit(path) || !withinTree(root, absolute)) {
        throw new BbPortError("refused", "The file is not in the thread's storage");
      }
      let read;
      try {
        read = await sdk.files.read({ hostId: location.hostId, rootPath: root, path: absolute });
      } catch {
        throw new BbPortError("failed", "BB could not read the thread file");
      }
      if (typeof read.path === "string" && read.path.replace(/\/+$/, "") !== absolute.replace(/\/+$/, "")) {
        throw new BbPortError("refused", "The path goes through a symbolic link");
      }
      const bytes = read.contentEncoding === "base64" ? Buffer.from(read.content, "base64") : Buffer.from(read.content, "utf8");
      return { bytes: new Uint8Array(bytes), mimeType: read.mimeType ?? null, sizeBytes: bytes.byteLength };
    },

    async uploadAttachment(projectId, bytes, filename, mimeType): Promise<BbInputItem> {
      const uploaded = await sdk.projects.attachments.upload({ projectId, clientFile: bytes, filename, mimeType });
      return { type: "localFile", path: uploaded.path, name: uploaded.name, mimeType: uploaded.mimeType ?? mimeType };
    },

    async defaultPermissionMode(projectId): Promise<BbPermissionMode | null> {
      const defaults = await sdk.projects.defaultExecutionOptions({ projectId });
      return defaults?.permissionMode ?? null;
    },
  };
}
