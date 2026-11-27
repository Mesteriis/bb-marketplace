import { builtinTemplates } from "./builtin.ts";
import { ciTemplate, templateIssues, type CiForge, type CiTemplate } from "./render.ts";
import type { Stack, StackValues } from "./stack.ts";

export type TemplateSource = "builtin" | "settings" | "folder";
/** An own template as read: its JSON, or why it could not be read. */
export type OwnEntry = {source: Exclude<TemplateSource, "builtin">; name: string; raw: unknown; error?: string};
export type Offered = {key: string; source: TemplateSource; template: CiTemplate; matches: boolean};
export type Rejected = {source: TemplateSource; name: string; issues: string[]};

/** Own templates from the settings' JSON list, or from one JSON file of the templates folder. */
export function ownTemplates(source: OwnEntry["source"], text: string, file?: string): OwnEntry[] {
  if (source === "settings" && !text.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    return [{source, name: file ?? "settings", raw: null, error: source === "settings" ? "The CI templates setting is not a JSON list." : "The file is not JSON."}];
  }
  if (source === "folder") return [{source, name: file!, raw: value}];
  if (!Array.isArray(value)) return [{source, name: "settings", raw: null, error: "The CI templates setting is not a JSON list."}];
  return value.map((raw, index) => ({source, name: typeof (raw as {id?: unknown})?.id === "string" ? (raw as {id: string}).id : "#" + (index + 1), raw}));
}

/**
 * The templates offered for a forge: the ones of the found stacks first, stack by stack and own before built-in, then
 * the rest by title. An own template that fails the checks is listed with its reasons and not offered.
 */
export function offerTemplates(forge: CiForge, stacks: Stack[], own: OwnEntry[]): {offered: Offered[]; rejected: Rejected[]} {
  const rejected: Rejected[] = [];
  const candidates: Offered[] = [];
  const keys = new Set<string>();
  for (const entry of own) {
    const issues = entry.error ? [entry.error] : templateIssues(entry.raw);
    const template = issues.length ? null : ciTemplate.parse(entry.raw);
    const key = template ? entry.source + ":" + template.id : "";
    if (template && keys.has(key)) issues.push("Another " + entry.source + " template has the id " + template.id + ".");
    if (issues.length || !template) { rejected.push({source: entry.source, name: entry.name, issues}); continue; }
    keys.add(key);
    candidates.push({key, source: entry.source, template, matches: false});
  }
  for (const template of builtinTemplates) candidates.push({key: "builtin:" + template.id, source: "builtin", template, matches: false});
  const order = stacks.map(stack => stack.id);
  const rank = (entry: Offered) => {
    const at = entry.template.stacks.map(id => order.indexOf(id)).filter(index => index >= 0);
    return at.length ? Math.min(...at) : order.length;
  };
  const offered = candidates.filter(entry => entry.template.forge === forge).map(entry => ({...entry, matches: rank(entry) < order.length}));
  offered.sort((a, b) => rank(a) - rank(b) || Number(a.source === "builtin") - Number(b.source === "builtin") || a.template.title.localeCompare(b.template.title));
  return {offered, rejected};
}

/**
 * The values suggested for a template: the defaults of the found stacks it is written for, then the repository's
 * default branch and its name as a local image name.
 */
export function templateDefaults(template: CiTemplate, stacks: Stack[], repo: {branch: string | null; name: string}): StackValues {
  const values: StackValues = {};
  for (const stack of stacks) if (template.stacks.includes(stack.id)) for (const [key, value] of Object.entries(stack.defaults)) if (!(key in values)) values[key] = value;
  const image = repo.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 60);
  return {...values, branch: repo.branch ?? "main", image: image || "app"};
}
