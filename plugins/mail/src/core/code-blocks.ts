// Code in a plain mail body (slice 3g, #51): fenced blocks, unified diffs
// split per file, indented runs and log runs, found line by line (no regular
// expression runs over more than one line). The page shows text parts as
// today and the rest with BB's highlighter or its <pre> fallback. Pure.

export type BodyPart =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language: string | null; path: string }
  | { kind: "diff"; files: { path: string; patch: string }[] }
  | { kind: "log"; text: string; path: "snippet.log" };

export const CODE_BLOCKS_MAX = 50;
export const CODE_CHARS_MAX = 200_000;
/** Shortest indented run taken as code. */
const INDENTED_MIN_LINES = 3;
/** Shortest log run taken as a log. */
const LOG_MIN_LINES = 5;

/** Known languages and their file names, so the highlighter picks the grammar. */
const EXTENSIONS: Record<string, string> = {
  js: "js", javascript: "js", mjs: "js", cjs: "js", jsx: "jsx",
  ts: "ts", typescript: "ts", tsx: "tsx",
  py: "py", python: "py", rb: "rb", ruby: "rb", go: "go", golang: "go",
  rs: "rs", rust: "rs", java: "java", kt: "kt", kotlin: "kt", swift: "swift",
  c: "c", h: "h", cpp: "cpp", "c++": "cpp", cc: "cpp", cs: "cs", csharp: "cs", "c#": "cs",
  php: "php", sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh", ps1: "ps1", powershell: "ps1",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", xml: "xml", html: "html", css: "css",
  scss: "scss", sql: "sql", md: "md", markdown: "md", diff: "diff", patch: "diff", graphql: "graphql",
  lua: "lua", r: "r", scala: "scala", dart: "dart", vue: "vue", svelte: "svelte", hcl: "hcl", tf: "tf",
  terraform: "tf", proto: "proto", log: "log", text: "txt", txt: "txt", plaintext: "txt",
};

/** "snippet.<ext>" for a known language ("Dockerfile" for dockerfile), else "snippet.txt". */
export function snippetPath(language: string | null): string {
  const key = language === null ? "" : language.trim().toLowerCase();
  if (key === "dockerfile" || key === "docker") return "Dockerfile";
  const extension = Object.hasOwn(EXTENSIONS, key) ? EXTENSIONS[key] : undefined;
  return `snippet.${extension ?? "txt"}`;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9+#._-]{0,32})[ \t]*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LANGUAGE = /^[a-z0-9+#-]{1,32}$/;

/** Lines a unified diff is made of. */
function isDiffLine(line: string): boolean {
  if (line === "") return false;
  const first = line[0];
  if (first === " " || first === "+" || first === "-" || first === "\\") return true;
  return (
    line.startsWith("@@") ||
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity index") ||
    line.startsWith("dissimilarity index") ||
    line.startsWith("rename from") ||
    line.startsWith("rename to") ||
    line.startsWith("copy from") ||
    line.startsWith("copy to") ||
    line.startsWith("Binary files") ||
    line.startsWith("GIT binary patch") ||
    line.startsWith("literal ") ||
    line.startsWith("delta ")
  );
}

function diffStarts(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  if (line.startsWith("diff --git ")) return true;
  return line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ") && (lines[i + 2] ?? "").startsWith("@@");
}

/** The path a file of a diff is shown under: the new path, or the old one for a deletion. */
function diffPath(fileLines: readonly string[]): string {
  const strip = (path: string) => path.replace(/^"|"$/g, "").replace(/^[ab]\//, "").split("\t")[0]!.trim();
  const plus = fileLines.find((line) => line.startsWith("+++ "));
  if (plus !== undefined && !plus.startsWith("+++ /dev/null")) return strip(plus.slice(4));
  const minus = fileLines.find((line) => line.startsWith("--- "));
  if (minus !== undefined && !minus.startsWith("--- /dev/null")) return strip(minus.slice(4));
  const header = fileLines[0]?.startsWith("diff --git ") === true ? fileLines[0].slice("diff --git ".length) : "";
  const b = header.lastIndexOf(" b/");
  return b === -1 ? "snippet.diff" : header.slice(b + 3).trim() || "snippet.diff";
}

/**
 * One entry per file: a new file starts at "diff --git", or (a bare diff) at
 * "--- " followed by "+++ " once the current file has a hunk.
 */
function splitDiff(diffLines: readonly string[]): { path: string; patch: string }[] {
  const files: string[][] = [];
  let current: string[] = [];
  let hunk = false;
  diffLines.forEach((line, i) => {
    const gitHeader = line.startsWith("diff --git ");
    const bareHeader = line.startsWith("--- ") && (diffLines[i + 1] ?? "").startsWith("+++ ") && hunk;
    if (current.length > 0 && (gitHeader || bareHeader)) {
      files.push(current);
      current = [];
      hunk = false;
    }
    if (line.startsWith("@@")) hunk = true;
    current.push(line);
  });
  if (current.length > 0) files.push(current);
  return files.map((file) => ({ path: diffPath(file), patch: file.join("\n") }));
}

const TIMESTAMP = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const CLOCK = /^\[?\d{2}:\d{2}:\d{2}/;
const LEVEL = /^\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL|PANIC)\b/;
const FRAME = /^\s+at \S/;

function isLogLine(line: string): boolean {
  return TIMESTAMP.test(line) || CLOCK.test(line) || LEVEL.test(line) || FRAME.test(line);
}

/** A log run may hold one exception line ("x.y.Error: ...") between log lines. */
function isLogContinuation(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  return line.trim() !== "" && !line.startsWith(">") && FRAME.test(lines[i + 1] ?? "") && i > 0 && isLogLine(lines[i - 1]!);
}

const LIST_MARKER = /^([-*+\u2022]|\d{1,3}[.)])\s/;

function isIndented(line: string): boolean {
  if (!(line.startsWith("    ") || line.startsWith("\t"))) return false;
  const rest = line.trim();
  return rest !== "" && !LIST_MARKER.test(rest) && !rest.startsWith(">");
}

function dedent(lines: readonly string[]): string {
  return lines.map((line) => (line.startsWith("\t") ? line.slice(1) : line.startsWith("    ") ? line.slice(4) : line)).join("\n");
}

/**
 * The body as text and code parts, in order. At most 50 blocks and 200 000
 * characters of block text; past either, the rest stays text.
 */
export function codeBlocks(text: string): BodyPart[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const parts: BodyPart[] = [];
  let pendingText: string[] = [];
  let blocks = 0;
  let chars = 0;
  const flushText = () => {
    const joined = pendingText.join("\n");
    if (joined.trim() !== "") parts.push({ kind: "text", text: joined });
    pendingText = [];
  };
  /** Adds a block when the caps allow it; false when the lines must stay text. */
  const add = (part: Exclude<BodyPart, { kind: "text" }>, size: number): boolean => {
    if (blocks >= CODE_BLOCKS_MAX || chars + size > CODE_CHARS_MAX) return false;
    flushText();
    parts.push(part);
    blocks++;
    chars += size;
    return true;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const marker = fence[1]!;
      let end = i + 1;
      while (end < lines.length) {
        const close = FENCE_CLOSE.exec(lines[end]!);
        if (close !== null && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
        end++;
      }
      const body = lines.slice(i + 1, end).join("\n");
      const lower = fence[2]!.toLowerCase();
      const language = LANGUAGE.test(lower) ? lower : null;
      if (add({ kind: "code", text: body, language, path: snippetPath(language) }, body.length)) {
        i = Math.min(end + 1, lines.length);
        continue;
      }
    }
    if (diffStarts(lines, i)) {
      let end = i + 1;
      while (end < lines.length && (isDiffLine(lines[end]!) || (lines[end] === "" && isDiffLine(lines[end + 1] ?? "") && (lines[end + 1] ?? "").startsWith(" ")))) end++;
      const diffLines = lines.slice(i, end);
      const size = diffLines.join("\n").length;
      if (diffLines.length >= 2 && add({ kind: "diff", files: splitDiff(diffLines) }, size)) {
        i = end;
        continue;
      }
    }
    if (isLogLine(line) && !line.startsWith(" ") && !line.startsWith("\t")) {
      let end = i + 1;
      while (end < lines.length && (isLogLine(lines[end]!) || isLogContinuation(lines, end))) end++;
      if (end - i >= LOG_MIN_LINES) {
        const body = lines.slice(i, end).join("\n");
        if (add({ kind: "log", text: body, path: "snippet.log" }, body.length)) {
          i = end;
          continue;
        }
      }
    }
    const afterBlank = i === 0 || lines[i - 1]!.trim() === "";
    if (afterBlank && isIndented(line)) {
      let end = i + 1;
      while (end < lines.length && (isIndented(lines[end]!) || (lines[end]!.trim() === "" && isIndented(lines[end + 1] ?? "")))) end++;
      const run = lines.slice(i, end);
      const nonBlank = run.filter((entry) => entry.trim() !== "").length;
      if (nonBlank >= INDENTED_MIN_LINES) {
        const body = dedent(run);
        if (add({ kind: "code", text: body, language: null, path: "snippet.txt" }, body.length)) {
          i = end;
          continue;
        }
      }
    }
    pendingText.push(line);
    i++;
  }
  flushText();
  return parts;
}
