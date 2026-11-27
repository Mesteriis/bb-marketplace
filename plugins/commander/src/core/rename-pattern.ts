import { z } from "zod";
import type { Entry } from "./model.ts";
import { NameSegment } from "./path.ts";

/** A regex may run at most this long on one name (artboard rename.html: «лимит 50 мс на имя»). */
export const REGEX_TIME_LIMIT_MS = 50;

const Counter = z.object({
  start: z.number().int().min(0).max(1_000_000_000),
  step: z.number().int().min(1).max(1_000_000),
  width: z.number().int().min(1).max(12),
}).strict();

export const RenamePattern = z.object({
  template: z.string().max(1024).optional(),
  find: z.union([
    z.object({ text: z.string().min(1).max(512) }).strict(),
    z.object({ regex: z.string().min(1).max(512) }).strict(),
  ]).optional(),
  replace: z.string().max(512).optional(),
  case: z.enum(["keep", "lower", "upper", "title"]).optional(),
  counter: Counter.optional(),
}).strict();
export type RenamePattern = z.infer<typeof RenamePattern>;

export type RenameProblem =
  | "empty" | "invalid_name" | "duplicate" | "exists"
  | "invalid_regex" | "unsafe_regex" | "regex_timeout";

export interface RenamePreview {
  from: NameSegment;
  /** The new name; null when the pattern cannot produce a valid one. */
  to: NameSegment | null;
  problem: RenameProblem | null;
}

export interface PreviewOptions {
  /** The whole directory listing. Names here stay taken unless the batch renames them away. */
  directory?: Entry[];
  caseSensitive?: boolean;
}

// Placeholder for [E] while the case transform runs, so the extension keeps its own case.
const EXT_MARK = "";

/** Name split at the first dot that is not the leading character, as in naming.ts. */
function splitText(name: string): { base: string; ext: string } {
  const dot = name.indexOf(".", 1);
  return dot === -1 ? { base: name, ext: "" } : { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/**
 * Nested quantifiers such as (a+)+ or (.*)* backtrack exponentially on a failing
 * name. JavaScript cannot interrupt a running RegExp, so such patterns are refused
 * before they run. Heuristic: a group that contains a quantifier and is itself quantified.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,?\d*\})/;

function compileFind(find: NonNullable<RenamePattern["find"]>): RegExp | null {
  if (!("regex" in find)) return null;
  if (NESTED_QUANTIFIER.test(find.regex)) throw new RenameRefusal("unsafe_regex");
  try {
    return new RegExp(find.regex, "g");
  } catch {
    throw new RenameRefusal("invalid_regex");
  }
}

class RenameRefusal extends Error {
  constructor(readonly problem: RenameProblem) {
    super(problem);
  }
}

function applyFind(base: string, pattern: RenamePattern, regex: RegExp | null): string {
  const find = pattern.find;
  if (!find) return base;
  const replacement = pattern.replace ?? "";
  if (regex) {
    const started = globalThis.performance.now();
    const out = base.replace(regex, replacement);
    if (globalThis.performance.now() - started > REGEX_TIME_LIMIT_MS) throw new RenameRefusal("regex_timeout");
    return out;
  }
  return base.split((find as { text: string }).text).join(replacement);
}

const TOKEN = /\[(N|E|C(?::(\d{1,2}))?|N(\d{1,3})-(\d{1,3}))\]/g;

function expandTemplate(template: string, base: string, counter: number, width: number): string {
  return template.replace(TOKEN, (token, _all, cWidth: string | undefined, from: string | undefined, to: string | undefined) => {
    if (token === "[N]") return base;
    if (token === "[E]") return EXT_MARK;
    if (cWidth !== undefined || token.startsWith("[C")) {
      const digits = cWidth === undefined ? width : Number(cWidth);
      return String(counter).padStart(digits, "0");
    }
    if (from !== undefined && to !== undefined) {
      const start = Number(from);
      const end = Number(to);
      return start < 1 || end < start ? "" : Array.from(base).slice(start - 1, end).join("");
    }
    return token;
  });
}

function applyCase(text: string, mode: NonNullable<RenamePattern["case"]>): string {
  if (mode === "lower") return text.toLowerCase();
  if (mode === "upper") return text.toUpperCase();
  if (mode === "title") {
    return text.toLowerCase().replace(/(^|[\s_-])(\p{L})/gu, (_m, sep: string, letter: string) => sep + letter.toUpperCase());
  }
  return text;
}

/**
 * The new full name for one entry, before any directory-level check. `index` is the
 * entry's position in the selection; the counter is start + index × step.
 * Throws RenameRefusal("empty") when the base name is left empty.
 */
function renderName(name: string, pattern: RenamePattern, index: number, regex: RegExp | null): string {
  const { base, ext } = splitText(name);
  const found = applyFind(base, pattern, regex);
  const withExt = (text: string) => (ext === "" ? text : text + "." + ext);
  if (pattern.template === undefined) {
    const kept = applyCase(found, pattern.case ?? "keep");
    if (kept === "") throw new RenameRefusal("empty");
    return withExt(kept);
  }
  const width = pattern.counter?.width ?? 1;
  const counter = (pattern.counter?.start ?? 1) + index * (pattern.counter?.step ?? 1);
  const templated = expandTemplate(pattern.template, found, counter, width);
  const cased = applyCase(templated.replace(EXT_MARK, ""), pattern.case ?? "keep");
  const stripped = cased.replace("", "");
  if (stripped === "" || stripped === "." + ext) throw new RenameRefusal("empty");
  return cased.includes("") ? cased.replace("", ext) : withExt(cased);
}

function keyOf(text: string, caseSensitive: boolean): string {
  return caseSensitive ? text : text.normalize("NFC").toLowerCase();
}

/**
 * Computes the new name of every selected entry and marks what would fail.
 * Pure: reads the listing it is given, touches no endpoint.
 */
export function previewRename(selected: Entry[], pattern: RenamePattern, options: PreviewOptions = {}): RenamePreview[] {
  const caseSensitive = options.caseSensitive ?? true;
  const directory = options.directory ?? selected;
  let regex: RegExp | null = null;
  let refusal: RenameProblem | null = null;
  try {
    regex = pattern.find ? compileFind(pattern.find) : null;
  } catch (error) {
    if (!(error instanceof RenameRefusal)) throw error;
    refusal = error.problem;
  }

  const rows: { from: NameSegment; to: NameSegment | null; problem: RenameProblem | null; changed: boolean }[] =
    selected.map((entry, index) => {
      const from = entry.name;
      if (refusal !== null) return { from, to: null, problem: refusal, changed: false };
      if (!("t" in from)) return { from, to: null, problem: "invalid_name", changed: false };
      const text = from.t;
      let rendered: string;
      try {
        rendered = renderName(text, pattern, index, regex);
      } catch (error) {
        if (!(error instanceof RenameRefusal)) throw error;
        return { from, to: null, problem: error.problem, changed: false };
      }
      const parsed = NameSegment.safeParse({ t: rendered });
      if (!parsed.success) return { from, to: null, problem: "invalid_name", changed: false };
      return { from, to: parsed.data, problem: null, changed: rendered !== text };
    });

  // Names that stay taken: the directory minus the entries this batch renames away.
  const renamedAway = new Set(rows.filter((row) => row.changed).map((row) => keyOf(
    "t" in row.from ? row.from.t : "", caseSensitive)));
  const taken = new Set(directory.filter((entry) => "t" in entry.name)
    .map((entry) => keyOf((entry.name as { t: string }).t, caseSensitive)));
  for (const key of renamedAway) taken.delete(key);
  // Entries that stay in place keep their own names taken; the renamed ones are out of this set.
  for (const row of rows) {
    if (!row.changed && "t" in row.from) taken.add(keyOf(row.from.t, caseSensitive));
  }

  const targetCount = new Map<string, number>();
  for (const row of rows) {
    if (row.to === null || !("t" in row.to)) continue;
    const key = keyOf(row.to.t, caseSensitive);
    targetCount.set(key, (targetCount.get(key) ?? 0) + 1);
  }

  return rows.map(({ from, to, problem, changed }) => {
    if (problem !== null) return { from, to, problem };
    // A name that stays is no conflict with itself; a renamed entry that wants it is.
    if (!changed || to === null || !("t" in to)) return { from, to, problem: null };
    const key = keyOf(to.t, caseSensitive);
    if (taken.has(key)) return { from, to, problem: "exists" };
    if ((targetCount.get(key) ?? 0) > 1) return { from, to, problem: "duplicate" };
    return { from, to, problem: null };
  });
}
