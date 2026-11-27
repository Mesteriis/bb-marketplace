// Which grammar paints a file, and how a patch's rows become code a highlighter can read. No I/O.

/** Grammars the diff highlights, by the ids of Shiki's language packages. */
export const LANGUAGES = [
  "typescript", "tsx", "javascript", "jsx", "json", "jsonc", "css", "scss", "less", "html", "vue", "svelte", "astro", "markdown", "yaml", "toml",
  "python", "ruby", "go", "rust", "java", "kotlin", "swift", "c", "cpp", "csharp", "php", "shellscript",
  "powershell", "sql", "dockerfile", "xml", "graphql", "lua", "dart", "scala", "elixir", "haskell", "ini", "make", "nix", "hcl",
  "terraform", "prisma", "proto", "objective-c", "perl", "r", "zig", "erlang", "clojure", "groovy",
] as const;
export type LanguageId = typeof LANGUAGES[number];

const byExtension: Record<string, LanguageId> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "jsonc", css: "css", scss: "scss", less: "less", html: "html", htm: "html", vue: "vue", svelte: "svelte",
  astro: "astro", md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml", toml: "toml", py: "python", pyi: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp",
  hpp: "cpp", hh: "cpp", cs: "csharp", php: "php", sh: "shellscript", bash: "shellscript", zsh: "shellscript", ps1: "powershell",
  sql: "sql", xml: "xml", svg: "xml", plist: "xml", graphql: "graphql", gql: "graphql", lua: "lua", dart: "dart", scala: "scala",
  ex: "elixir", exs: "elixir", hs: "haskell", ini: "ini", cfg: "ini", nix: "nix", hcl: "hcl", tf: "terraform", tfvars: "terraform",
  prisma: "prisma", proto: "proto", m: "objective-c", pl: "perl", pm: "perl", r: "r", zig: "zig", erl: "erlang", clj: "clojure",
  cljs: "clojure", groovy: "groovy", gradle: "groovy",
};
const byName: Record<string, LanguageId> = {dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "make", gnumakefile: "make",
  gemfile: "ruby", rakefile: "ruby", jenkinsfile: "groovy"};

/** The grammar for a path, from its file name (Dockerfile, Makefile and their variants) or extension; null for none. */
export function languageOf(path: string): LanguageId | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const stem = name.split(".")[0];
  if (byName[name]) return byName[name];
  if (stem && byName[stem]) return byName[stem];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? byExtension[name.slice(dot + 1)] ?? null : null;
}

type Row = {kind: string; text: string};
/** The line of each side a row is on: a context row is on both, a removed one on the old side only. */
export type RowPlace = {old: number | null; new: number | null};
const side = (kind: string) => kind === "context" || kind === "ctx" ? "both" : kind === "deletion" || kind === "del" ? "old" : kind === "addition" || kind === "add" ? "new" : null;

/**
 * A patch's two sides as code: the old side (context and removed lines) and the new side (context and added lines),
 * hunk after hunk, so a grammar reads each in order. `at` gives each row's line on each side; null for a hunk header.
 */
export function highlightPlan(rows: readonly Row[]): {old: string; new: string; at: (RowPlace | null)[]} {
  const old: string[] = [], next: string[] = [];
  const at = rows.map(row => {
    const where = side(row.kind);
    if (!where) return null;
    const place: RowPlace = {old: null, new: null};
    if (where !== "new") { place.old = old.length; old.push(row.text); }
    if (where !== "old") { place.new = next.length; next.push(row.text); }
    return place;
  });
  return {old: old.join("\n"), new: next.join("\n"), at};
}

/** Whether a requested grammar is one the plugin serves. */
export const isLanguage = (value: string): value is LanguageId => (LANGUAGES as readonly string[]).includes(value);
