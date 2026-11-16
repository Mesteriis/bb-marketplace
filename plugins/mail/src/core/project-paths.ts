// Where Mail may write inside a project's working tree (slice 3g): a relative
// folder of plain segments and a sanitized file name, never a dot-first
// folder, never .git, never outside the tree. Shortcut files and names that
// agents read as instructions are saved with ".txt" so nothing opens or
// steers an agent by being saved. Pure: the adapter re-checks the absolute
// path with withinTree before it writes.
import { FILE_NAME_MAX, sanitizeFileName } from "./file-names.ts";

export const PROJECT_FOLDER_MAX_SEGMENTS = 8;
export const PROJECT_FOLDER_MAX_CHARS = 240;

export type ProjectPathRefusal =
  | "empty"
  | "too_long"
  | "too_deep"
  | "absolute"
  | "backslash"
  | "drive"
  | "home"
  | "dot_segment"
  | "git"
  | "hidden"
  | "unsafe_segment"
  | "unsafe_name";

/** What the owner is told when a folder or name is refused. */
export const PROJECT_PATH_REFUSAL_TEXT: Record<ProjectPathRefusal, string> = {
  empty: "The folder has an empty part",
  too_long: "The folder is longer than 240 characters",
  too_deep: "The folder is deeper than 8 levels",
  absolute: "The folder must be inside the project",
  backslash: "Use / between folders",
  drive: "The folder must be inside the project",
  home: "The folder must be inside the project",
  dot_segment: "The folder cannot hold . or ..",
  git: "Mail does not write into .git",
  hidden: "Mail does not write into folders that start with a dot",
  unsafe_segment: "A folder name holds characters a file name cannot have",
  unsafe_name: "The file name is not safe",
};

const DRIVE = /^[A-Za-z]:(\/|$)/;

/** ".git" in any case, also with trailing dots or spaces (which some file systems drop). */
function isGitSegment(segment: string): boolean {
  let end = segment.length;
  while (end > 0 && (segment[end - 1] === "." || segment[end - 1] === " ")) end--;
  return segment.slice(0, end).toLowerCase() === ".git";
}

/** A folder relative to the working tree, checked segment by segment. */
export function projectFolder(
  folder: string,
): { ok: true; segments: string[] } | { ok: false; reason: ProjectPathRefusal } {
  if (folder === "") return { ok: false, reason: "empty" };
  if (folder.length > PROJECT_FOLDER_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (folder.includes("\\")) return { ok: false, reason: "backslash" };
  if (folder.startsWith("/")) return { ok: false, reason: "absolute" };
  if (DRIVE.test(folder)) return { ok: false, reason: "drive" };
  const segments = folder.split("/");
  if (segments.length > PROJECT_FOLDER_MAX_SEGMENTS) return { ok: false, reason: "too_deep" };
  for (const segment of segments) {
    if (segment === "") return { ok: false, reason: "empty" };
    if (segment === "." || segment === "..") return { ok: false, reason: "dot_segment" };
    if (segment.startsWith("~")) return { ok: false, reason: "home" };
    if (isGitSegment(segment)) return { ok: false, reason: "git" };
    if (segment.startsWith(".")) return { ok: false, reason: "hidden" };
    if (sanitizeFileName(segment, "") !== segment) return { ok: false, reason: "unsafe_segment" };
  }
  return { ok: true, segments };
}

/** Shortcut files that open something when clicked. */
const SHORTCUT_EXTENSIONS = [".lnk", ".url", ".webloc", ".desktop"];

/** Base names (case-folded) that coding agents read as instructions (spec resolution 11). */
const AGENT_INSTRUCTION_NAMES = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  "skill.md",
  "mcp.json",
  ".mcp.json",
  "cursorrules",
  ".cursorrules",
  "windsurfrules",
  ".windsurfrules",
  "clinerules",
  ".clinerules",
  "copilot-instructions.md",
]);

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/** Whether a file's base name is one agents read as instructions. */
export function agentInstructionName(name: string): boolean {
  const base = baseName(name).toLowerCase();
  return AGENT_INSTRUCTION_NAMES.has(base) || (base.endsWith(".mdc") && base.length > ".mdc".length);
}

/** The name an attachment is saved under: sanitized, with ".txt" after shortcut and instruction names. */
export function savedName(filename: string | null): string {
  const name = sanitizeFileName(filename, "attachment");
  const lower = name.toLowerCase();
  const inert = SHORTCUT_EXTENSIONS.some((extension) => lower.endsWith(extension)) || agentInstructionName(name);
  // Sanitizing again keeps the 120-character cap with ".txt" as the extension.
  return inert ? sanitizeFileName(`${name}.txt`, "attachment") : name;
}

/** Compound extensions kept whole when a number is put before them. */
const COMPOUND_EXTENSION = /\.tar\.(gz|bz2|xz|zst)$/i;

function extensionOf(name: string): string {
  const compound = COMPOUND_EXTENSION.exec(name);
  if (compound !== null && compound.index > 0) return name.slice(compound.index);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** "report (2).pdf" for n 2 to 99, the extension kept, within 120 characters. */
export function keepBothName(name: string, n: number): string {
  if (!Number.isInteger(n) || n < 2 || n > 99) throw new RangeError("keepBothName numbers 2 to 99");
  const extension = extensionOf(name);
  const stem = name.slice(0, name.length - extension.length);
  const suffix = ` (${n})${extension}`;
  const room = FILE_NAME_MAX - Array.from(suffix).length;
  const kept = Array.from(stem).slice(0, Math.max(0, room)).join("").trimEnd();
  return `${kept}${suffix}`;
}

/** The path of a saved file relative to the working tree. */
export function projectRelativePath(
  folder: string,
  name: string,
): { ok: true; relativePath: string } | { ok: false; reason: ProjectPathRefusal } {
  const checked = projectFolder(folder);
  if (!checked.ok) return checked;
  if (name === "" || sanitizeFileName(name, "") !== name) return { ok: false, reason: "unsafe_name" };
  return { ok: true, relativePath: [...checked.segments, name].join("/") };
}

/** "/"-separated absolute path with "." and ".." resolved and doubled slashes collapsed; null when relative or it climbs above the root. */
function normalizeAbsolute(path: string): string | null {
  if (!path.startsWith("/") || path.includes("\\")) return null;
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return `/${out.join("/")}`;
}

/** Whether `absolute`, normalized, lies strictly inside the tree (prefix tree + "/"). */
export function withinTree(treePath: string, absolute: string): boolean {
  const tree = normalizeAbsolute(treePath);
  const target = normalizeAbsolute(absolute);
  if (tree === null || target === null) return false;
  const prefix = tree === "/" ? "/" : `${tree}/`;
  return target.startsWith(prefix) && target.length > prefix.length;
}

/** Whether a file name looks like it holds credentials (a second confirmation before attaching it). */
export function sensitiveName(name: string): boolean {
  const base = baseName(name).toLowerCase();
  let start = 0;
  while (start < base.length && base[start] === ".") start++;
  const plain = base.slice(start);
  if (base.startsWith(".env")) return true;
  if (plain === "env" || plain.startsWith("env.")) return true;
  if (plain.endsWith(".pem") || plain.endsWith(".key") || plain.endsWith(".p12")) return true;
  if (plain.startsWith("id_")) return true;
  if (plain.startsWith("credentials") || plain.startsWith("secrets")) return true;
  return plain === "npmrc" || plain === "netrc";
}

/** Whether any segment of a path is .git (any case, trailing dots or spaces). */
export function underGit(path: string): boolean {
  return path.split(/[/\\]/).some(isGitSegment);
}
