import type { CollectionEntry } from "./collection";
import type { SearchSource } from "./contract";
import type { RegistryServer } from "./registry";

export interface DeclaredVariable {
  name: string;
  description: string | null;
  isRequired: boolean;
  isSecret: boolean;
  /** The server's default; written for a non-secret variable the owner leaves empty. */
  default: string | null;
}

/** Environment variables the chosen package declares; remotes with headers are not installable yet, so they declare none. */
export function declaredVariables(server: RegistryServer, entry: CollectionEntry): DeclaredVariable[] {
  if (entry.choice.kind !== "package") return [];
  const pkg = server.packages?.[entry.choice.index];
  return (pkg?.environmentVariables ?? []).map((variable) => ({
    name: variable.name,
    description: variable.description ?? null,
    isRequired: variable.isRequired === true,
    isSecret: variable.isSecret === true,
    default: variable.default ?? null,
  }));
}

export type LauncherKind = "npm" | "pypi" | "oci";

/** Which launcher the chosen package needs; null for a remote address. */
export function launcherKindOf(server: RegistryServer, entry: CollectionEntry): LauncherKind | null {
  if (entry.choice.kind !== "package") return null;
  return server.packages?.[entry.choice.index]?.registryType ?? null;
}

export function sourcesOf(server: RegistryServer): SearchSource[] {
  const sources = new Set<SearchSource>();
  for (const pkg of server.packages ?? []) {
    sources.add(pkg.registryType === "oci" ? "docker" : pkg.registryType);
  }
  if ((server.remotes ?? []).length > 0) sources.add("remote");
  return [...sources];
}

const SUMMARY_LIMIT = 320;

/** First prose paragraph of a review report, headings and fences skipped, cut to a short extract. */
export function reviewSummary(markdown: string): string {
  let fenced = false;
  const kept: string[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.startsWith("#")) continue;
    if (line === "") {
      if (kept.length > 0) break;
      continue;
    }
    kept.push(line);
  }
  const text = kept.join(" ").replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim();
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…` : text;
}
