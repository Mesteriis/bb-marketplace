import { scaffold, scaffoldIssues, type Scaffold } from "./model.ts";

export type ScaffoldSource = "builtin" | "settings" | "folder";
export type OwnScaffold = {source: Exclude<ScaffoldSource, "builtin">; name: string; raw: unknown; error?: string};
export type OfferedScaffold = {key: string; source: ScaffoldSource; scaffold: Scaffold};

/** Own scaffolds from the settings' JSON list, or from one JSON file of the scaffolds folder. */
export function ownScaffolds(source: OwnScaffold["source"], text: string, file?: string): OwnScaffold[] {
  if (source === "settings" && !text.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    return [{source, name: file ?? "settings", raw: null, error: source === "settings" ? "The scaffolds setting is not a JSON list." : "The file is not JSON."}];
  }
  if (source === "folder") return [{source, name: file!, raw: value}];
  if (!Array.isArray(value)) return [{source, name: "settings", raw: null, error: "The scaffolds setting is not a JSON list."}];
  return value.map((raw, index) => ({source, name: typeof (raw as {id?: unknown})?.id === "string" ? (raw as {id: string}).id : "#" + (index + 1), raw}));
}

/**
 * The scaffolds offered: the built-in ones, then own ones in the order read. An own scaffold that fails the checks is
 * listed with its reasons and not offered; one whose key is taken already is not offered twice.
 */
export function offerScaffolds(builtin: Scaffold[], own: OwnScaffold[]) {
  const offered: OfferedScaffold[] = builtin.map(item => ({key: "builtin:" + item.id, source: "builtin", scaffold: item}));
  const rejected: {source: ScaffoldSource; name: string; issues: string[]}[] = [];
  for (const entry of own) {
    const issues = entry.error ? [entry.error] : scaffoldIssues(entry.raw);
    if (issues.length) { rejected.push({source: entry.source, name: entry.name, issues}); continue; }
    const parsed = scaffold.parse(entry.raw);
    const key = entry.source + ":" + parsed.id;
    if (!offered.some(item => item.key === key)) offered.push({key, source: entry.source, scaffold: parsed});
  }
  return {offered, rejected};
}
