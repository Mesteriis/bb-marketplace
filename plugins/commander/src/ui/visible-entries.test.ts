import { expect, test } from "vitest";
import type { Entry } from "../core/model.ts";
import { mergeVisible, visibleEntries, type Tab } from "./model.ts";

const entry = (t: string, kind: Entry["kind"] = "file", size = "1", mtimeNs: string | null = null): Entry => ({
  name: { t }, kind, size, mtimeNs, mtimePrecision: "unknown", mode: null, linkTarget: null, hidden: false,
});
const tab = (sort: Tab["sort"], filter = ""): Tab => ({
  endpoint: "host:x", path: { segments: [] }, sort, filter, selection: [], scrollTop: 0,
});
const names = (entries: Entry[]) => entries.map((item) => (item.name as { t: string }).t);

test("puts directories first and orders names with numbers by value", () => {
  const rows = [entry("file10"), entry("file2"), entry("Бета", "dir"), entry("alpha", "dir"), entry("file1")];
  expect(names(visibleEntries(rows, tab({ by: "name", direction: "asc" })))).toEqual(["Бета", "alpha", "file1", "file2", "file10"]);
  expect(names(visibleEntries(rows, tab({ by: "name", direction: "desc" })))).toEqual(["alpha", "Бета", "file10", "file2", "file1"]);
});

test("orders by size and by time with missing times first, ties broken by name ascending", () => {
  const rows = [entry("b", "file", "10", "30"), entry("a", "file", "10", "20"), entry("c", "file", "2", null), entry("d", "file", "99999999999999999999", "5")];
  expect(names(visibleEntries(rows, tab({ by: "size", direction: "asc" })))).toEqual(["c", "a", "b", "d"]);
  expect(names(visibleEntries(rows, tab({ by: "size", direction: "desc" })))).toEqual(["d", "a", "b", "c"]);
  expect(names(visibleEntries(rows, tab({ by: "mtime", direction: "asc" })))).toEqual(["c", "d", "a", "b"]);
});

test("filters by a case-insensitive part of the displayed name", () => {
  const rows = [entry("Отчёт.txt"), entry("отчёт-2.txt"), entry("other.bin")];
  expect(names(visibleEntries(rows, tab({ by: "name", direction: "asc" }, "ОТЧЁТ")))).toEqual(["отчёт-2.txt", "Отчёт.txt"]);
});

test("reads each entry name a bounded number of times, not once per comparison", () => {
  let reads = 0;
  const rows = Array.from({ length: 2000 }, (_, index) => {
    const text = "item-" + String((index * 7919) % 2000).padStart(4, "0");
    const name = { get t() { reads++; return text; } };
    return { ...entry("x"), name } as Entry;
  });
  const sorted = visibleEntries(rows, tab({ by: "name", direction: "asc" }));
  expect(sorted).toHaveLength(2000);
  expect((sorted[0]!.name as { t: string }).t).toBe("item-0000");
  // Per entry: the display name once, the sort key for ties. A comparator that converts names runs about 2000 * 11 * 2 times.
  expect(reads).toBeLessThan(2000 * 8);
});

test.each([
  [{ by: "name", direction: "asc" }, ""], [{ by: "name", direction: "desc" }, ""], [{ by: "size", direction: "asc" }, ""],
  [{ by: "mtime", direction: "desc" }, ""], [{ by: "kind", direction: "asc" }, ""], [{ by: "name", direction: "asc" }, "7"],
] as const)("merging pages one by one gives exactly the full sort (%j, filter %j)", (sort, filter) => {
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const rows = Array.from({ length: 900 }, (_, index) => entry(
    "f" + Math.floor(random() * 400) + "-" + index, random() < 0.1 ? "dir" : "file",
    String(Math.floor(random() * 50)), random() < 0.2 ? null : String(Math.floor(random() * 30))));
  const view = tab({ ...sort }, filter);
  let merged: Entry[] = [];
  for (let at = 0; at < rows.length; at += 97) merged = mergeVisible(merged, rows.slice(at, at + 97), view);
  expect(names(merged)).toEqual(names(visibleEntries(rows, view)));
});
