// Patches from mail (slice 3g, #78): detection, a line-by-line parse of git
// format-patch messages and unified diffs, refusals for paths that could
// reach outside a working tree or into .git, and warnings for files that run
// or steer things. Mail never applies a patch: the owner saves it or hands it
// to an agent in a fresh worktree. Pure.
import { sha256Hex } from "./compose.ts";
import { sanitizeFileName } from "./file-names.ts";
import { agentInstructionName, underGit } from "./project-paths.ts";

export const PATCH_MAX_BYTES = 1_048_576;
export const PATCH_FILES_MAX = 200;

export type PatchStatus = "added" | "deleted" | "renamed" | "copied" | "modified";

export type PatchFile = {
  oldPath: string | null;
  newPath: string | null;
  added: number;
  removed: number;
  status: PatchStatus;
  binary: boolean;
  symlink: boolean;
  executable: boolean;
  /** This file's part of the patch, for the diff view. */
  patch: string;
};

export type ParsedPatch = {
  files: PatchFile[];
  commitMessage: string | null;
  refused: string | null;
  warnings: string[];
};

const PATCH_TYPES = new Set(["text/x-patch", "text/x-diff"]);

/** An attachment named *.patch / *.diff or typed as a patch, at most 1 MB. */
export function isPatchAttachment(part: { filename: string | null; mimeType: string; size: number }): boolean {
  if (part.size < 0 || part.size > PATCH_MAX_BYTES) return false;
  const name = (part.filename ?? "").trim().toLowerCase();
  return name.endsWith(".patch") || name.endsWith(".diff") || PATCH_TYPES.has(part.mimeType.trim().toLowerCase());
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function bareDiffAt(lines: readonly string[], i: number): boolean {
  return lines[i]!.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ") && (lines[i + 2] ?? "").startsWith("@@");
}

/** The body when it holds a git format-patch message or a bare unified diff, else null. */
export function patchFromBody(text: string): string | null {
  if (text.length > PATCH_MAX_BYTES || byteLength(text) > PATCH_MAX_BYTES) return null;
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("diff --git ") || bareDiffAt(lines, i)) return text;
  }
  return null;
}

/**
 * File and line counts for thread_get, in one pass without the full parse
 * (patch_view parses): "diff --git" headers (else bare ---/+++/@@ diffs),
 * and +/- lines after the first header.
 */
export function patchSummary(text: string): { files: number; added: number; removed: number } {
  const lines = splitLines(text);
  let files = 0;
  let added = 0;
  let removed = 0;
  let inDiff = false;
  let git = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      if (!git) files = 0;
      git = true;
      inDiff = true;
      files++;
      continue;
    }
    if (!git && bareDiffAt(lines, i)) {
      inDiff = true;
      files++;
      i++;
      continue;
    }
    if (!inDiff || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-") && line !== "-- ") removed++;
  }
  return { files, added, removed };
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A C-style quoted path (git's core.quotePath form) unescaped; null when it cannot be read. */
function unquote(quoted: string): string | null {
  if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) return null;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const inner = quoted.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if (char === '"') return null;
    if (char !== "\\") {
      const code = inner.codePointAt(i)!;
      const piece = String.fromCodePoint(code);
      bytes.push(...encoder.encode(piece));
      i += piece.length - 1;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) return null;
    if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]!);
      i++;
    } else if (/^[0-3][0-7]{2}$/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      return null;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** A path as written (maybe quoted), with git's a/ or b/ prefix dropped when asked; undefined when unreadable. */
function readPath(raw: string, prefixed: boolean): string | null | undefined {
  let value = raw.startsWith('"') ? unquote(raw) : raw;
  if (value === null) return undefined;
  if (value === "/dev/null") return null;
  if (prefixed && (value.startsWith("a/") || value.startsWith("b/"))) value = value.slice(2);
  return value;
}

/** The two paths of a "diff --git" line; undefined entries when unreadable. */
function gitHeaderPaths(rest: string): [string | null | undefined, string | null | undefined] {
  if (rest.startsWith('"')) {
    let end = 1;
    while (end < rest.length && !(rest[end] === '"' && rest[end - 1] !== "\\")) end++;
    const a = rest.slice(0, end + 1);
    const b = rest.slice(end + 1).trim();
    return [readPath(a, true), readPath(b, true)];
  }
  const quotedB = rest.indexOf(' "b/');
  if (quotedB !== -1) return [readPath(rest.slice(0, quotedB), true), readPath(rest.slice(quotedB + 1), true)];
  const plainB = rest.indexOf(" b/");
  if (plainB !== -1) return [readPath(rest.slice(0, plainB), true), readPath(rest.slice(plainB + 1), true)];
  const space = rest.indexOf(" ");
  return space === -1 ? [undefined, undefined] : [readPath(rest.slice(0, space), true), readPath(rest.slice(space + 1), true)];
}

/** The value of a ---/+++ line: quoted or not, a tab and timestamp dropped. */
function markerPath(value: string): string | null | undefined {
  const raw = value.startsWith('"') ? value.trimEnd() : value.split("\t")[0]!.trimEnd();
  return readPath(raw, true);
}

/** Why a path may not be in a patch, or null. */
function pathProblem(path: string): string | null {
  if (path === "") return "A path in the patch is empty";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "A path in the patch is absolute";
  if (path.includes("\\")) return "A path in the patch holds a backslash";
  if (path.split("/").some((segment) => segment === "..")) return "A path in the patch climbs out of the project";
  if (underGit(path)) return "The patch writes into .git";
  return null;
}

type Work = {
  lines: string[];
  oldPath: string | null;
  newPath: string | null;
  added: number;
  removed: number;
  newFile: boolean;
  deletedFile: boolean;
  rename: boolean;
  copy: boolean;
  binary: boolean;
  symlink: boolean;
  executable: boolean;
  hunks: number;
};

function newWork(oldPath: string | null, newPath: string | null): Work {
  return {
    lines: [], oldPath, newPath, added: 0, removed: 0, newFile: false, deletedFile: false,
    rename: false, copy: false, binary: false, symlink: false, executable: false, hunks: 0,
  };
}

const MBOX_FROM = /^From [0-9a-f]{40} /;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
/** A header line is at most 998 characters (RFC 5322); a longer subject is cut before it is read. */
const SUBJECT_MAX = 998;
/** How far the closing "]" of a "[PATCH ...]" prefix may be. */
const PREFIX_MAX = 200;
/** "rename from <path>" / "copy from <path>" and their "to" lines. */
const MOVE_SOURCE = /^(rename|copy) from (.+)$/;
const MOVE_TARGET = /^(rename|copy) to (.+)$/;

/** The subject without a leading "[... PATCH ...]" prefix; a scan, no regular expression (no backtracking). */
function withoutPatchPrefix(subject: string): string {
  const value = subject.trimStart();
  if (!value.startsWith("[")) return value;
  const close = value.indexOf("]", 1);
  if (close === -1 || close > PREFIX_MAX) return value;
  if (!value.slice(1, close).toUpperCase().includes("PATCH")) return value;
  return value.slice(close + 1).trimStart();
}

function commitMessageOf(preamble: readonly string[]): string | null {
  let lines = [...preamble];
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  let subject: string | null = null;
  if (lines.length > 0 && MBOX_FROM.test(lines[0]!)) {
    let i = 1;
    for (; i < lines.length && lines[i] !== ""; i++) {
      const line = lines[i]!;
      if (/^Subject:/i.test(line)) subject = line.slice("Subject:".length, SUBJECT_MAX).trim();
      else if (subject !== null && /^[ \t]/.test(line) && /^Subject:/i.test(lines[i - 1] ?? "")) {
        subject = `${subject} ${line.slice(0, SUBJECT_MAX).trim()}`.slice(0, SUBJECT_MAX);
      }
    }
    lines = lines.slice(i + 1);
  }
  const end = lines.findIndex((line) => line === "---");
  const body = (end === -1 ? lines : lines.slice(0, end)).join("\n").trim();
  const title = subject === null ? "" : withoutPatchPrefix(subject).trim();
  const message = [title, body].filter((part) => part !== "").join("\n\n");
  return message === "" ? null : message;
}

const LOCK_FILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "cargo.lock",
  "poetry.lock", "pipfile.lock", "uv.lock", "gemfile.lock", "go.sum", "composer.lock", "flake.lock", "mix.lock",
]);

/**
 * Why a changed file deserves a second look, by its name only; null for none.
 * Read on the path as written and on it without its first segment, so a
 * mnemonic (c/ w/ i/ o/) or any other one-segment prefix pair, which
 * readPath keeps, still warns (git applies with -p1); with a/ b/ already
 * dropped, the second reading may add a warning, never remove one.
 */
function nameWarning(path: string): string | null {
  const slash = path.indexOf("/");
  return pathWarning(path) ?? (slash === -1 ? null : pathWarning(path.slice(slash + 1)));
}

function pathWarning(path: string): string | null {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const base = segments[segments.length - 1]!;
  const folders = segments.slice(0, -1);
  if (lower.startsWith(".github/workflows/")) return "CI workflow";
  if (base === ".gitlab-ci.yml") return "CI configuration";
  if (folders.includes(".husky")) return "Git hook";
  if (folders.includes(".claude") || folders.includes(".cursor")) return "Agent settings";
  if (folders.includes(".bb")) return "BB settings";
  if (folders.includes(".vscode")) return "Editor tasks";
  if (agentInstructionName(base)) return "Agent instructions";
  if (base === "package.json") return "Package scripts may change";
  if (base === "makefile" || base === "gnumakefile") return "Build file";
  if (base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return "Container build file";
  if (base.endsWith(".sh")) return "Shell script";
  if (LOCK_FILES.has(base)) return "Lock file";
  if (base === ".envrc") return "Environment script";
  if (base === ".gitattributes" || base === ".gitmodules") return "Git settings";
  return null;
}

function finish(work: Work): PatchFile {
  const status: PatchStatus = work.rename
    ? "renamed"
    : work.copy
      ? "copied"
      : work.newFile || (work.oldPath === null && work.newPath !== null)
        ? "added"
        : work.deletedFile || (work.newPath === null && work.oldPath !== null)
          ? "deleted"
          : "modified";
  return {
    oldPath: status === "added" ? null : work.oldPath,
    newPath: status === "deleted" ? null : work.newPath,
    added: work.added,
    removed: work.removed,
    status,
    binary: work.binary,
    symlink: work.symlink,
    executable: work.executable,
    patch: work.lines.join("\n"),
  };
}

function refusedWith(reason: string): ParsedPatch {
  return { files: [], commitMessage: null, refused: reason, warnings: [] };
}

/**
 * The files, the commit message and the warnings of a patch, or the reason
 * it is refused: larger than 1 MB, more than 200 files, a path that is
 * absolute, climbs with "..", holds a backslash or names .git (any case,
 * trailing dots or spaces), a quoted path that cannot be read, or no diff.
 */
export function parsePatch(text: string): ParsedPatch {
  if (text.length > PATCH_MAX_BYTES || byteLength(text) > PATCH_MAX_BYTES) return refusedWith("The patch is larger than 1 MB");
  const lines = splitLines(text);
  const works: Work[] = [];
  const preamble: string[] = [];
  const named: (string | null | undefined)[] = [];
  let current: Work | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const start = (work: Work) => {
    works.push(work);
    current = work;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const work = current as Work | null;
    if (work !== null && (oldLeft > 0 || newLeft > 0)) {
      const first = line[0];
      if (line === "" || first === " ") {
        oldLeft--;
        newLeft--;
        work.lines.push(line);
        continue;
      }
      if (first === "-") {
        oldLeft--;
        work.removed++;
        work.lines.push(line);
        continue;
      }
      if (first === "+") {
        newLeft--;
        work.added++;
        work.lines.push(line);
        continue;
      }
      if (first === "\\") {
        work.lines.push(line);
        continue;
      }
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("diff --git ")) {
      const [a, b] = gitHeaderPaths(line.slice("diff --git ".length));
      named.push(a, b);
      start(newWork(a ?? null, b ?? null));
      current!.lines.push(line);
      continue;
    }
    if (bareDiffAt(lines, i) && (work === null || work.hunks > 0)) {
      start(newWork(null, null));
    }
    const target = current as Work | null;
    if (target === null) {
      if (works.length === 0) preamble.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      const hunk = HUNK.exec(line);
      if (hunk !== null) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
        target.hunks++;
      }
    } else if (line.startsWith("--- ")) {
      const path = markerPath(line.slice(4));
      named.push(path);
      if (path !== undefined) target.oldPath = path;
    } else if (line.startsWith("+++ ")) {
      const path = markerPath(line.slice(4));
      named.push(path);
      if (path !== undefined) target.newPath = path;
    } else if (MOVE_SOURCE.test(line)) {
      const move = MOVE_SOURCE.exec(line)!;
      const path = readPath(move[2]!, false);
      named.push(path);
      if (path !== undefined) target.oldPath = path;
      if (move[1] === "rename") target.rename = true;
      else target.copy = true;
    } else if (MOVE_TARGET.test(line)) {
      const path = readPath(MOVE_TARGET.exec(line)![2]!, false);
      named.push(path);
      if (path !== undefined) target.newPath = path;
    } else if (line.startsWith("new file mode ")) {
      target.newFile = true;
      noteMode(target, line.slice("new file mode ".length));
    } else if (line.startsWith("deleted file mode ")) {
      target.deletedFile = true;
      if (line.endsWith("120000")) target.symlink = true;
    } else if (line.startsWith("new mode ")) {
      noteMode(target, line.slice("new mode ".length));
    } else if (line.startsWith("index ")) {
      const mode = line.split(" ")[2];
      if (mode !== undefined) noteMode(target, mode);
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      target.binary = true;
    } else if (line === "-- " || MBOX_FROM.test(line)) {
      // The format-patch signature or the next message of a series: not part of this file.
      current = null;
      continue;
    }
    target.lines.push(line);
  }

  if (works.length === 0) return refusedWith("This does not look like a patch");
  if (works.length > PATCH_FILES_MAX) return refusedWith(`The patch changes more than ${PATCH_FILES_MAX} files`);
  for (const path of named) {
    if (path === undefined) return refusedWith("A path in the patch cannot be read");
    if (path === null) continue;
    const problem = pathProblem(path);
    if (problem !== null) return refusedWith(problem);
  }
  const files = works.map(finish);
  for (const file of files) {
    if (file.oldPath === null && file.newPath === null) return refusedWith("This does not look like a patch");
  }
  const warnings: string[] = [];
  for (const file of files) {
    const path = file.newPath ?? file.oldPath ?? "";
    if (file.binary) warnings.push(`Binary change: ${path}`);
    if (file.symlink) warnings.push(`Symbolic link: ${path}`);
    if (file.executable) warnings.push(`Executable file: ${path}`);
    for (const each of new Set([file.oldPath, file.newPath])) {
      if (each === null) continue;
      const reason = nameWarning(each);
      if (reason !== null) warnings.push(`${reason}: ${each}`);
    }
  }
  return { files, commitMessage: commitMessageOf(preamble), refused: null, warnings: [...new Set(warnings)] };
}

function noteMode(work: Work, mode: string): void {
  const value = mode.trim();
  if (value === "120000") work.symlink = true;
  if (value === "100755") work.executable = true;
}

/** The SHA-256 of the patch bytes, hex: the dialog's reference, checked again on save and hand-off. */
export function patchRef(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

/** "<YYYY-MM-DD>-<subject>.patch": the subject without [PATCH ...], lower case, letters and digits joined by "-". */
export function patchFileName(date: string | null, subject: string): string {
  const time = date === null ? NaN : Date.parse(date);
  const day = Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
  const words = withoutPatchPrefix(subject.slice(0, 1_000))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const stem = [day, Array.from(words).slice(0, 80).join("").replace(/-+$/, "")].filter((part) => part !== "").join("-");
  return sanitizeFileName(`${stem === "" ? "mail" : stem}.patch`, "mail.patch");
}
