import { expect, test } from "vitest";
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

test('find regex IMG_(\\d+) replaced by "photo-$1" on "IMG_12.jpg" → "photo-12.jpg"', () => {
  const rows = names([file("IMG_12.jpg")], { find: { regex: "IMG_(\\d+)" }, replace: "photo-$1" });
  expect(rows).toEqual([{ to: "photo-12.jpg", problem: null }]);
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
