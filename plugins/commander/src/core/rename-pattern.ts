import { z } from "zod";
import type { Entry } from "./model.ts";
import { compileName } from "./glob.ts";
import { CommanderError } from "./errors.ts";
import { NameSegment } from "./path.ts";

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
  | "invalid_regex" | "unsafe_regex";

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

// Stands for [E] while the case transform runs, so the extension keeps its own case.
const EXT_MARK = "";

/** Name split at the first dot that is not the leading character, as in naming.ts. */
function splitText(name: string): { base: string; ext: string } {
  const dot = name.indexOf(".", 1);
  return dot === -1 ? { base: name, ext: "" } : { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

class RenameRefusal extends Error {
  constructor(readonly problem: RenameProblem) {
    super(problem);
  }
}

/**
 * The find regex is accepted only in the flat subset that S11 search uses (glob.ts):
 * no groups, no alternation, at most one repetition, at most 256 characters. Such an
 * expression cannot backtrack exponentially, so it runs without a time limit.
 */
function compileFind(find: NonNullable<RenamePattern["find"]>): RegExp | null {
  if (!("regex" in find)) return null;
  try {
    compileName({ regex: find.regex }, true);
  } catch (error) {
    if (error instanceof CommanderError && error.code === "invalid_name") throw new RenameRefusal("invalid_regex");
    if (error instanceof CommanderError) throw new RenameRefusal("unsafe_regex");
    throw error;
  }
  return new RegExp(find.regex, "gu");
}

/** The replacement is literal: no $1 or other substitution patterns. */
function applyFind(base: string, pattern: RenamePattern, regex: RegExp | null): string {
  const find = pattern.find;
  if (!find) return base;
  const replacement = pattern.replace ?? "";
  if (regex) return base.replace(regex, () => replacement);
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
  if (pattern.template === undefined) {
    const kept = applyCase(found, pattern.case ?? "keep");
    if (kept === "") throw new RenameRefusal("empty");
    return ext === "" ? kept : kept + "." + ext;
  }
  // Without an extension, the dot before [E] and [E] itself disappear, so no trailing dot is left.
  const template = ext === "" ? pattern.template.replace(/\.?\[E\]/g, "") : pattern.template;
  const width = pattern.counter?.width ?? 1;
  const counter = (pattern.counter?.start ?? 1) + index * (pattern.counter?.step ?? 1);
  const cased = applyCase(expandTemplate(template, found, counter, width), pattern.case ?? "keep");
  const baseText = cased.split(EXT_MARK).join("");
  if (baseText === "" || baseText === ".") throw new RenameRefusal("empty");
  if (template.includes("[E]")) return cased.split(EXT_MARK).join(ext);
  return ext === "" ? cased : cased + "." + ext;
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
