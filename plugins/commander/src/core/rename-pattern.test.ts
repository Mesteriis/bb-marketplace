import { afterEach, expect, test, vi } from "vitest";
import type { Entry } from "./model.ts";
import { previewRename, type RenamePattern } from "./rename-pattern.ts";

function file(name: string): Entry {
  return {
    name: { t: name }, kind: "file", size: "3", mtimeNs: "1", mtimePrecision: "ns",
    mode: null, linkTarget: null, hidden: false,
  };
}

function names(entries: Entry[], pattern: RenamePattern, options?: Parameters<typeof previewRename>[2]) {
  return previewRename(entries, pattern, options).map((row) => ({
    to: row.to && "t" in row.to ? row.to.t : null,
    problem: row.problem,
  }));
}

test('template "[N]_[C]" counter{1,1,3} on ["a.txt","b.txt"] → ["a_001.txt","b_002.txt"]', () => {
  const rows = names([file("a.txt"), file("b.txt")], {
    template: "[N]_[C]", counter: { start: 1, step: 1, width: 3 },
  });
  expect(rows).toEqual([
    { to: "a_001.txt", problem: null },
    { to: "b_002.txt", problem: null },
  ]);
});

test('template "site-hero-[C:3].[E]" with counter start 5 on "x.webp" → "site-hero-005.webp"', () => {
  const rows = names([file("x.webp")], { template: "site-hero-[C:3].[E]", counter: { start: 5, step: 1, width: 1 } });
  expect(rows).toEqual([{ to: "site-hero-005.webp", problem: null }]);
});

test('find regex IMG_[0-9]+ replaced by a literal "photo-" on "IMG_12.jpg" → "photo-12.jpg"', () => {
  const rows = names([file("IMG_12.jpg")], { find: { regex: "IMG_[0-9]+" }, replace: "photo-" });
  expect(rows).toEqual([{ to: "photo-.jpg", problem: null }]);
});

test('the replacement is literal: "$1" is not a group reference', () => {
  const rows = names([file("a.txt")], { find: { regex: "a" }, replace: "[$1]" });
  expect(rows).toEqual([{ to: "[$1].txt", problem: null }]);
});

// Counts every RegExp built from `source` and every exec/test on such an expression. A use of the
// tested source throws, so a regression fails fast instead of backtracking on the long name.
function watchRegExp(source: string, refuse = true) {
  const seen = { constructed: 0, executed: 0 };
  const Original = globalThis.RegExp;
  const exec = Original.prototype.exec;
  const execute = function (this: RegExp, input: string) {
    if (this.source === source) {
      seen.executed++;
      if (refuse) throw new Error("the refused expression was executed");
    }
    return exec.call(this, input);
  };
  class Watched extends Original {
    constructor(pattern: string | RegExp, flags?: string) {
      super(pattern, flags);
      if (this.source === source) seen.constructed++;
    }
  }
  vi.stubGlobal("RegExp", Watched);
  vi.spyOn(Original.prototype, "exec").mockImplementation(execute);
  vi.spyOn(Original.prototype, "test").mockImplementation(function (this: RegExp, input: string) {
    return execute.call(this, input) !== null;
  });
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each(["a*a*b", "a*a*a*b", "a*a*a*a*b"])("polynomial regex %s is refused as unsafe_regex without building or running it", (source) => {
  const seen = watchRegExp(source);
  const rows = names([file("a".repeat(200) + "!")], { find: { regex: source }, replace: "x" });
  expect(rows).toEqual([{ to: null, problem: "unsafe_regex" }]);
  expect(seen).toEqual({ constructed: 0, executed: 0 });
});

test("the RegExp watch sees a safe expression being built and run", () => {
  const seen = watchRegExp("IMG_[0-9]+", false);
  const rows = names([file("IMG_12.jpg")], { find: { regex: "IMG_[0-9]+" }, replace: "photo-" });
  expect(rows).toEqual([{ to: "photo-.jpg", problem: null }]);
  expect(seen.constructed).toBeGreaterThan(0);
  expect(seen.executed).toBeGreaterThan(0);
});

test('literal find "draft" replaced by "final" with case upper on "draft-a.txt" → "FINAL-A.txt"', () => {
  const rows = names([file("draft-a.txt")], { find: { text: "draft" }, replace: "final", case: "upper" });
  expect(rows).toEqual([{ to: "FINAL-A.txt", problem: null }]);
});

test('case title on "my photo.txt" → "My Photo.txt"', () => {
  const rows = names([file("my photo.txt")], { template: "[N]", case: "title" });
  expect(rows).toEqual([{ to: "My Photo.txt", problem: null }]);
});

test('slice [N1-3] on "photo.jpg" → "pho.jpg"', () => {
  const rows = names([file("photo.jpg")], { template: "[N1-3].[E]" });
  expect(rows).toEqual([{ to: "pho.jpg", problem: null }]);
});

test('two sources mapping to "x.txt" → both problem "duplicate"', () => {
  const rows = previewRename([file("a.txt"), file("b.txt")], { template: "x" });
  expect(rows.map((row) => row.problem)).toEqual(["duplicate", "duplicate"]);
  expect(rows.map((row) => (row.to && "t" in row.to ? row.to.t : null))).toEqual(["x.txt", "x.txt"]);
});

test('a target that exists in the directory and is not part of the batch → problem "exists"', () => {
  const directory = [file("a.txt"), file("x.txt")];
  const rows = previewRename([file("a.txt")], { template: "x" }, { directory });
  expect(rows[0].problem).toBe("exists");
});

test('a target held by another batch source that moves away is not "exists"', () => {
  // Counter from 2: 1.txt → 2.txt (held by 2.txt, which moves to 3.txt) and 2.txt → 3.txt.
  const selected = [file("1.txt"), file("2.txt")];
  const rows = names(selected, { template: "[C].[E]", counter: { start: 2, step: 1, width: 1 } }, { directory: selected });
  expect(rows).toEqual([
    { to: "2.txt", problem: null },
    { to: "3.txt", problem: null },
  ]);
});

test('a target held by an unchanged selected entry is "exists"', () => {
  // b.txt is not renamed (its template keeps the name), so a.txt → b.txt cannot be vacated.
  const selected = [file("a.txt"), file("b.txt")];
  const rows = names(selected, { find: { text: "a" }, replace: "b" }, { directory: selected });
  expect(rows[0].problem).toBe("exists");
});

test('case-only "A.txt" → "a.txt" on a case-insensitive endpoint is allowed', () => {
  const rows = names([file("A.txt")], { template: "a" }, { directory: [file("A.txt")], caseSensitive: false });
  expect(rows).toEqual([{ to: "a.txt", problem: null }]);
});

test('find a → "" leaving the base name empty → problem "empty"', () => {
  const rows = names([file("a.txt")], { find: { text: "a" }, replace: "" });
  expect(rows).toEqual([{ to: null, problem: "empty" }]);
});

test('template containing a slash → problem "invalid_name"', () => {
  const rows = names([file("a.txt")], { template: "a/b" });
  expect(rows).toEqual([{ to: null, problem: "invalid_name" }]);
});

test('nested quantifier regex (a+)+$ is refused as unsafe_regex before running', () => {
  const name = "a".repeat(50) + "!";
  const rows = names([file(name)], { find: { regex: "(a+)+$" }, replace: "x" });
  expect(rows).toEqual([{ to: null, problem: "unsafe_regex" }]);
});

test("an unchanged name keeps its entry and is no problem", () => {
  const rows = names([file("a.txt")], { template: "[N].[E]" });
  expect(rows).toEqual([{ to: "a.txt", problem: null }]);
});

test('alternation inside a quantified group (?:a|aa)+$ is refused as unsafe_regex', () => {
  const rows = names([file("aaaa!.txt")], { find: { regex: "(?:a|aa)+$" }, replace: "x" });
  expect(rows).toEqual([{ to: null, problem: "unsafe_regex" }]);
});

test('template ".[E]" on "a.txt" leaves the base empty → problem "empty"', () => {
  const rows = names([file("a.txt")], { template: ".[E]" });
  expect(rows).toEqual([{ to: null, problem: "empty" }]);
});

test('[E] used twice is replaced at every place: "[E]_[E]" on "a.txt" → "txt_txt"', () => {
  const rows = names([file("a.txt")], { template: "[E]_[E]" });
  expect(rows).toEqual([{ to: "txt_txt", problem: null }]);
});

test('the default template "[N].[E]" leaves a name without an extension unchanged: "README" stays "README"', () => {
  const rows = names([file("README")], { template: "[N].[E]" });
  expect(rows).toEqual([{ to: "README", problem: null }]);
});
