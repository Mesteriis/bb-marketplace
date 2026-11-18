// BB projects and their working trees for Mail (slice 3g): the project list
// (cached briefly), project files and folders for the pickers, a project
// file's bytes, and the create-only file writes of Save to project.
//
// Writes go only inside the project's working tree: the absolute path is
// the tree path plus a project-relative path the core built, re-checked here
// to lie strictly inside the tree, never under .git. Create-only is real:
// files.read first (any content is "exists"), then files.write with
// expectedSha256 null; Replace passes the sha the owner was shown. A read
// whose answer names another path than the one asked (a symbolic link) is
// refused; the SDK reports no other link marker, so this is best effort and
// the live check confirms the daemon's confinement (spec resolution 5).
// Errors carry codes only, never a path.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { projectFolder, underGit, withinTree } from "../../core/project-paths.ts";
import { repoRefOf, workingTree, type ProjectInfo } from "../../core/projects.ts";
import {
  BbPortError,
  type BbFileBytes,
  type BbFileEntry,
  type ProjectDirectory,
  type ProjectWriteResult,
  type WorkingTree,
} from "../../core/ports.ts";

/**
 * Saving attachments and patches into a project's working tree. The owner's
 * live check flips this to false when BB cannot confirm the file stays inside
 * the project (spec resolution 5); patch hand-off uploads and keeps working.
 */
export const SAVE_TO_PROJECT_ENABLED = true;

/** How long the project list is kept in memory. */
export const PROJECT_CACHE_MS = 60_000;

/** File mode of every saved file. */
export const SAVED_FILE_MODE = 0o644;

type ProjectsSdk = Pick<BbPluginApi["sdk"], "projects" | "files">;

export function createProjectDirectory(
  sdk: ProjectsSdk,
  options: { now?: () => number; cacheMs?: number } = {},
): ProjectDirectory {
  const now = options.now ?? (() => Date.now());
  const cacheMs = options.cacheMs ?? PROJECT_CACHE_MS;
  let cache: { at: number; projects: ProjectInfo[] } | null = null;

  async function exists(tree: WorkingTree, relativePath: string): Promise<{ sha256: string } | null> {
    const absolute = absoluteIn(tree, relativePath);
    let read;
    try {
      read = await sdk.files.read({ hostId: tree.hostId, rootPath: tree.path, path: absolute });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new BbPortError("failed", "BB could not read the project file");
    }
    if (typeof read.path === "string" && trimSlash(read.path) !== trimSlash(absolute)) {
      throw new BbPortError("refused", "The path goes through a symbolic link");
    }
    return { sha256: read.sha256 };
  }

  return {
    async list() {
      if (cache !== null && now() - cache.at < cacheMs) return cache.projects.map(copyProject);
      const listed = await sdk.projects.list();
      const projects = listed.map(
        (project): ProjectInfo => ({
          id: project.id,
          name: project.name,
          kind: project.kind,
          remote: project.gitRemoteUrl === null ? null : repoRefOf(project.gitRemoteUrl),
          tree: workingTree(project.sources),
        }),
      );
      cache = { at: now(), projects };
      return projects.map(copyProject);
    },

    async files(projectId, query, limit) {
      const result = await sdk.projects.files({ projectId, query, limit: String(limit) });
      return { files: result.files.filter((file) => !underGit(file.path)).map(entry), truncated: result.truncated };
    },

    async folders(projectId, query, limit) {
      const result = await sdk.projects.paths({
        projectId,
        query,
        limit: String(limit),
        includeDirectories: "true",
        includeFiles: "false",
      });
      // Only folders Mail may save into: no dot-first folder, no .git, sane segments.
      const folders = result.paths
        .filter((path) => path.kind === "directory" && projectFolder(path.path).ok)
        .map(entry);
      return { folders, truncated: result.truncated };
    },

    async fileContent(projectId, path): Promise<BbFileBytes> {
      if (underGit(path)) throw new BbPortError("refused", "Files under .git are not offered");
      const file = await sdk.projects.fileContent({ projectId, path });
      const bytes = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
      return { bytes: new Uint8Array(bytes), mimeType: file.mimeType || null, sizeBytes: bytes.byteLength };
    },

    exists,

    async write(tree, relativePath, bytes, opts): Promise<ProjectWriteResult> {
      if (!SAVE_TO_PROJECT_ENABLED) throw new BbPortError("disabled");
      const absolute = absoluteIn(tree, relativePath);
      const current = await exists(tree, relativePath);
      if (current !== null && (opts.replaceSha === null || current.sha256 !== opts.replaceSha)) {
        return { outcome: "exists", currentSha: current.sha256 };
      }
      let written;
      try {
        written = await sdk.files.write({
          hostId: tree.hostId,
          rootPath: tree.path,
          path: absolute,
          content: Buffer.from(bytes).toString("base64"),
          contentEncoding: "base64",
          createParents: true,
          mode: SAVED_FILE_MODE,
          // null: create only; the shown sha: replace exactly that file.
          expectedSha256: current === null ? null : opts.replaceSha,
        });
      } catch {
        throw new BbPortError("failed", "BB could not write the project file");
      }
      if (written.outcome === "conflict") return { outcome: "exists", currentSha: written.currentSha256 ?? "" };
      return { outcome: "written", sha256: written.sha256, sizeBytes: written.sizeBytes };
    },
  };
}

/** The absolute path of a project-relative path, refused unless strictly inside the tree and outside .git. */
function absoluteIn(tree: WorkingTree, relativePath: string): string {
  if (relativePath === "" || relativePath.startsWith("/") || relativePath.includes("\\") || underGit(relativePath)) {
    throw new BbPortError("refused", "The path is not inside the project");
  }
  const absolute = `${trimSlash(tree.path)}/${relativePath}`;
  if (!withinTree(tree.path, absolute)) throw new BbPortError("refused", "The path is not inside the project");
  return absolute;
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function entry(file: { name: string; path: string }): BbFileEntry {
  return { name: file.name, path: file.path };
}

function copyProject(project: ProjectInfo): ProjectInfo {
  return {
    ...project,
    remote: project.remote === null ? null : { ...project.remote },
    tree: project.tree === null ? null : { ...project.tree },
  };
}

/**
 * A not-found answer from BB's file calls. The SDK declares no error type
 * for it, so the status, code and message are read defensively; anything
 * else is a failure (and nothing is written).
 */
export function isNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const fields = error as { status?: unknown; code?: unknown; message?: unknown };
  if (fields.status === 404) return true;
  if (fields.code === "not_found" || fields.code === "ENOENT" || fields.code === "NOT_FOUND") return true;
  return typeof fields.message === "string" && /\b(not[ _]found|ENOENT|no such file)\b/i.test(fields.message);
}
