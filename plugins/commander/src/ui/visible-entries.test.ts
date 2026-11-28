import { expect, test } from "vitest";
import type { Entry } from "../core/model.ts";
import { visibleEntries, type Tab } from "./model.ts";

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

test("sorts 100 000 entries within a budget the panel can spend on every page it shows", () => {
  const rows = Array.from({ length: 100_000 }, (_, index) => entry("item-" + String((index * 7919) % 100_000).padStart(6, "0") + ".bin", "file", "1024", String(index)));
  const start = performance.now();
  const sorted = visibleEntries(rows, tab({ by: "name", direction: "asc" }));
  const elapsed = performance.now() - start;
  expect(names(sorted).slice(0, 2)).toEqual(["item-000000.bin", "item-000001.bin"]);
  expect(elapsed).toBeLessThan(1000);
});
