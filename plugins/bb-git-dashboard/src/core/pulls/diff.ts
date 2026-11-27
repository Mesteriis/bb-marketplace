// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// Changed files, their patches and where a line comment anchors. No I/O.

// ---- Changed files (REST /pulls/{n}/files) ----

export interface RestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PrFile {
  path: string;
  previousPath: string | null;
  /** added, removed, modified, renamed, copied, changed, unchanged */
  status: string;
  additions: number;
  deletions: number;
  /** Null for binary files, files GitHub will not diff, or very large patches. */
  patch: string | null;
}

const MAX_PATCH = 200_000;

export function toFiles(files: RestFile[]): PrFile[] {
  return files.map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch && f.patch.length <= MAX_PATCH ? f.patch : null,
  }));
}


// ---- Reviewing: line comments and submitting a review ----

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** GitHub's per-file REST patch, as rows with the line numbers a comment needs. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop(); // a trailing newline is not a context line
  for (const row of rows) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ kind: "hunk", text: row, oldLine: null, newLine: null });
    } else if (row.startsWith("\\")) {
      continue; // "\ No newline at end of file" belongs to neither side
    } else if (row.startsWith("+")) {
      out.push({ kind: "add", text: row.slice(1), oldLine: null, newLine: newLine++ });
    } else if (row.startsWith("-")) {
      out.push({ kind: "del", text: row.slice(1), oldLine: oldLine++, newLine: null });
    } else {
      out.push({ kind: "ctx", text: row.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return out;
}

/** Where GitHub anchors a comment on this row: removed lines on the old side, the rest on the new. */
export function commentTarget(row: DiffLine): { side: "LEFT" | "RIGHT"; line: number } | null {
  if (row.kind === "hunk") return null;
  return row.kind === "del" ? { side: "LEFT", line: row.oldLine! } : { side: "RIGHT", line: row.newLine! };
}

export interface CommentRange {
  side: "LEFT" | "RIGHT";
  line: number;
  /** Set only when the comment spans more than one line. */
  start: { side: "LEFT" | "RIGHT"; line: number } | null;
}

/**
 * The comment for rows `a`..`b` (either order), anchored on the lower row like
 * GitHub. Null when a hunk header sits between them: GitHub only accepts a
 * range inside one hunk.
 */
export function commentRange(rows: DiffLine[], a: number, b: number): CommentRange | null {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const end = rows[to] ? commentTarget(rows[to]!) : null;
  const begin = rows[from] ? commentTarget(rows[from]!) : null;
  if (!end || !begin) return null;
  if (rows.slice(from, to + 1).some((r) => r.kind === "hunk")) return null;
  return { ...end, start: from === to ? null : begin };
}


export function fullPatch(file: Pick<PrFile, "path" | "previousPath" | "status" | "patch">): string {
  const before = file.previousPath ?? file.path;
  return [
    `diff --git a/${before} b/${file.path}`,
    file.status === "added" ? "--- /dev/null" : `--- a/${before}`,
    file.status === "removed" ? "+++ /dev/null" : `+++ b/${file.path}`,
    file.patch ?? "",
  ].join("\n");
}

/**
 * A plain github.com pull request link → the PR it names. Null for anything else: other hosts,
 * sub-pages (/files, /checks) and #comment links, which only GitHub can land on.
 */
export function prFromUrl(href: string): { repo: string; number: number } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // Same owner/name rule as the server's prRef.
  const m = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d{0,9})\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.hash || !m) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

