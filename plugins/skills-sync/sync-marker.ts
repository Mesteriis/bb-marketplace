import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Source } from "./contract";
import { isSinglePathSegment } from "./path-safety";
import { SyncError } from "./sync-error";

/** Resolve and validate the configured install root. */
export function resolveInstallRoot(source: Source): string {
  if (!path.isAbsolute(source.installRoot)) {
    throw new SyncError(
      `Source "${source.id}" has a relative installRoot ("${source.installRoot}"); it must be an absolute path.`,
    );
  }
  return path.resolve(source.installRoot);
}

/** Resolve one direct child of installRoot without permitting path escape. */
export function resolveInstallEntry(
  source: Source,
  entry: string,
  description: string,
): string {
  const root = resolveInstallRoot(source);
  const resolved = path.resolve(root, entry);
  if (path.dirname(resolved) !== root) {
    throw new SyncError(
      `${description} "${entry}" must be a single path segment inside ${source.installRoot}.`,
    );
  }
  return resolved;
}

function markerPath(source: Source): string {
  if (!isSinglePathSegment(source.marker)) {
    throw new SyncError(
      `Marker "${source.marker}" must be a single filename inside ${source.installRoot}.`,
    );
  }
  return resolveInstallEntry(source, source.marker, "Marker");
}

export function readMarker(source: Source): string | null {
  const file = markerPath(source);
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * Replace the marker atomically. The temporary file is beside the target, so
 * a failed write or rename leaves the previous marker intact.
 */
export interface MarkerFileOps {
  writeFileSync(
    file: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx" },
  ): void;
  renameSync(source: string, destination: string): void;
  unlinkSync(file: string): void;
}

const defaultFileOps: MarkerFileOps = {
  writeFileSync: (file, data, options) => {
    fs.writeFileSync(file, data, options);
  },
  renameSync: (source, destination) => {
    fs.renameSync(source, destination);
  },
  unlinkSync: (file) => {
    fs.unlinkSync(file);
  },
};

export function writeMarker(
  source: Source,
  sha: string,
  fileOps: MarkerFileOps = defaultFileOps,
): void {
  const root = resolveInstallRoot(source);
  const target = markerPath(source);
  fs.mkdirSync(root, { recursive: true });
  const temporary = path.join(
    root,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fileOps.writeFileSync(temporary, `${sha}\n`, { encoding: "utf8", flag: "wx" });
    fileOps.renameSync(temporary, target);
  } catch (error) {
    try {
      fileOps.unlinkSync(temporary);
    } catch {
      // The original marker is the important durability guarantee. Cleanup
      // is best-effort if the write or rename failed.
    }
    throw error;
  }
}
