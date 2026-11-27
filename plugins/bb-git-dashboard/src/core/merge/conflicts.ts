// Conflict markers as Git writes them (merge, diff3 and zdiff3 styles) and the text a set of choices makes. No I/O.

export type Segment = {kind: "text"; lines: string[]}
  | {kind: "conflict"; ours: string[]; base: string[] | null; theirs: string[]; labels: {ours: string; base: string; theirs: string}};
export type Parsed = {segments: Segment[]; finalNewline: boolean};
/**
 * How one conflict is answered: one side, both in either order, the common ancestor (when the markers carry it),
 * chosen lines of each side (by index, the first side's lines first), or text typed by hand.
 */
export type Choice = {kind: "ours"} | {kind: "theirs"} | {kind: "base"} | {kind: "both"; first: "ours" | "theirs"}
  | {kind: "lines"; ours: number[]; theirs: number[]; first: "ours" | "theirs"} | {kind: "text"; text: string};

// Markers are seven characters at the start of a line (Git's default conflict-marker-size); a label follows a space.
const start = /^<{7}(?: (.*))?$/, base = /^\|{7}(?: (.*))?$/, separator = /^={7}$/, end = /^>{7}(?: (.*))?$/;
const bare = (line: string) => line.endsWith("\r") ? line.slice(0, -1) : line;

/** A file's text as plain runs and conflict blocks. An unclosed block is plain text (and still has markers). */
export function parseConflicts(text: string): Parsed {
  const finalNewline = text.endsWith("\n");
  const lines = text === "" ? [] : (finalNewline ? text.slice(0, -1) : text).split("\n");
  const segments: Segment[] = [];
  const plain = (line: string) => {
    const last = segments.at(-1);
    if (last?.kind === "text") last.lines.push(line); else segments.push({kind: "text", lines: [line]});
  };
  for (let index = 0; index < lines.length;) {
    const opening = start.exec(bare(lines[index]!));
    const block = opening ? readBlock(lines, index, opening[1] ?? "") : null;
    if (!block) { plain(lines[index]!); index++; continue; }
    segments.push(block.segment);
    index = block.next;
  }
  return {segments, finalNewline};
}

function readBlock(lines: string[], from: number, ours: string): {segment: Segment; next: number} | null {
  const parts: {ours: string[]; base: string[] | null; theirs: string[]} = {ours: [], base: null, theirs: []};
  let labelBase = "";
  let part: "ours" | "base" | "theirs" = "ours";
  for (let index = from + 1; index < lines.length; index++) {
    const line = bare(lines[index]!);
    const baseMark = part === "ours" ? base.exec(line) : null;
    if (baseMark) { part = "base"; parts.base = []; labelBase = baseMark[1] ?? ""; continue; }
    if (part !== "theirs" && separator.test(line)) { part = "theirs"; continue; }
    const closing = part === "theirs" ? end.exec(line) : null;
    if (closing) {
      return {segment: {kind: "conflict", ...parts, labels: {ours, base: labelBase, theirs: closing[1] ?? ""}}, next: index + 1};
    }
    // A new block opening inside this one means this one never closed.
    if (start.test(line)) return null;
    (part === "base" ? parts.base! : parts[part]).push(lines[index]!);
  }
  return null;
}

export const conflictCount = (parsed: Parsed) => parsed.segments.filter(segment => segment.kind === "conflict").length;

/**
 * Whether a conflict's opening or closing marker is left: such text is never saved as resolved. A line of seven `=`
 * or `|` alone is ordinary text (a heading's underline), so only the markers that name a side count.
 */
export function hasMarkers(text: string): boolean {
  return text.split("\n").map(bare).some(line => start.test(line) || end.test(line));
}

/** Text typed in the browser (where line ends are LF) given the line ends of the file it replaces: CRLF when the file used them. */
export function lineEnds(text: string, original: string | null): string {
  return original?.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text;
}

function answer(segment: Extract<Segment, {kind: "conflict"}>, choice: Choice): string[] | null {
  switch (choice.kind) {
    case "ours": return segment.ours;
    case "theirs": return segment.theirs;
    case "base": return segment.base;
    case "both": return choice.first === "ours" ? [...segment.ours, ...segment.theirs] : [...segment.theirs, ...segment.ours];
    case "lines": {
      const pick = (side: string[], indexes: number[]) => [...new Set(indexes)].sort((a, b) => a - b).filter(index => index >= 0 && index < side.length).map(index => side[index]!);
      const ours = pick(segment.ours, choice.ours), theirs = pick(segment.theirs, choice.theirs);
      return choice.first === "ours" ? [...ours, ...theirs] : [...theirs, ...ours];
    }
    case "text": return choice.text === "" ? [] : choice.text.split("\n");
  }
}

/** The file's text with every conflict answered by its choice (in order); null while one is unanswered or impossible. */
export function resolveConflicts(parsed: Parsed, choices: readonly (Choice | null)[]): string | null {
  const out: string[] = [];
  let at = 0;
  for (const segment of parsed.segments) {
    if (segment.kind === "text") { out.push(...segment.lines); continue; }
    const choice = choices[at++];
    const lines = choice ? answer(segment, choice) : null;
    if (!lines) return null;
    out.push(...lines);
  }
  if (out.length === 0) return "";
  return out.join("\n") + (parsed.finalNewline ? "\n" : "");
}

/** A ref a merge or rebase may take: a local or remote-tracking branch. */
export const mergeRef = /^refs\/(?:heads|remotes)\/[A-Za-z0-9_][A-Za-z0-9_./-]{0,249}$/;

/** The merge commit's message, as Git words it: what came in, and into which branch unless that is main or master. */
export function mergeMessage(ref: string, branch: string | null): string {
  const remote = ref.startsWith("refs/remotes/");
  const name = ref.replace(/^refs\/(?:heads|remotes)\//, "");
  return "Merge " + (remote ? "remote-tracking branch '" : "branch '") + name + "'" + (branch && branch !== "main" && branch !== "master" ? " into " + branch : "");
}
