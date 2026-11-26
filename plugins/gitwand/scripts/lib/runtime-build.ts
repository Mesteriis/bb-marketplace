// Pure parts of build-runtime.ts: version and archive names, arguments, the
// Tauri plugin command scan of the built UI, and the checksum manifest.

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** `v3.14.0` + build 1 → `3.14.0+bb1`. Only plain release tags are built. */
export function runtimeVersion(tag: string, build: number): string {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (m === null) throw new Error(`not a release tag: ${tag} (expected vX.Y.Z)`);
  if (!Number.isInteger(build) || build < 1) throw new Error(`invalid build number: ${build}`);
  return `${m[1]}+bb${build}`;
}

export function archiveName(version: string, platform: string): string {
  return `gitwand-runtime-${version}-${platform}.tar.gz`;
}

export interface BuildArgs {
  tag: string;
  commit: string;
  platform: Platform;
  build: number;
  out: string | null;
  cargoHome: string | null;
}

export function parseBuildArgs(argv: string[]): BuildArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const allowed = ["--tag", "--commit", "--platform", "--build", "--out", "--cargo-home"];
    if (!allowed.includes(key)) throw new Error(`unknown option ${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${key} needs a value`);
    values.set(key, value);
  }
  const tag = values.get("--tag");
  if (tag === undefined) throw new Error("--tag is required");
  const commit = values.get("--commit");
  if (commit === undefined) throw new Error("--commit is required");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit must be a full 40 hex sha");
  const platform = values.get("--platform") as Platform | undefined;
  if (platform === undefined || !PLATFORMS.includes(platform)) throw new Error(`--platform must be one of ${PLATFORMS.join(", ")}`);
  const build = Number(values.get("--build") ?? "1");
  runtimeVersion(tag, build);
  return { tag, commit, platform, build, out: values.get("--out") ?? null, cargoHome: values.get("--cargo-home") ?? null };
}

/** Distinct `namespace|command` names of `plugin:…` invokes in a bundle, sorted. */
export function scanPluginCommands(js: string): string[] {
  const found = new Set<string>();
  for (const m of js.matchAll(/plugin:([a-z][a-z-]*\|[a-z_]+)/g)) found.add(m[1]);
  return [...found].sort();
}

export function unknownPluginCommands(found: string[], known: readonly string[]): string[] {
  return found.filter((name) => !known.includes(name));
}

/** `sha256sum`-format lines, sorted by path. */
export function manifestText(entries: { path: string; sha256: string }[]): string {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.path}\n`)
    .join("");
}

export interface CargoMetadata {
  packages: { id: string; name: string; version: string; license: string | null }[];
  resolve: { root: string | null; nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] } | null;
}

/**
 * `name version license` of every crate reachable from the root through
 * normal dependencies (build-only and dev edges are not followed), sorted.
 * Run `cargo metadata` with `--filter-platform` and the build's features so
 * the graph is the one that was compiled.
 */
export function shippedCrates(metadata: CargoMetadata): string[] {
  const root = metadata.resolve?.root;
  if (!root) throw new Error("cargo metadata has no resolved root package");
  const nodes = new Map(metadata.resolve!.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const dep of nodes.get(queue.shift()!)?.deps ?? []) {
      if (!dep.dep_kinds.some((k) => k.kind === null) || seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  seen.delete(root);
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  return [...seen]
    .map((id) => byId.get(id))
    .filter((p) => p !== undefined)
    .map((p) => `${p.name} ${p.version} ${p.license ?? "UNKNOWN"}`)
    .sort();
}

/** `name version license` lines from `pnpm licenses list --json`, sorted; paths dropped. */
export function jsLicenseLines(json: string): string[] {
  const byLicense = JSON.parse(json) as Record<string, { name: string; versions: string[] }[]>;
  return Object.entries(byLicense)
    .flatMap(([license, packages]) => packages.flatMap((p) => p.versions.map((v) => `${p.name} ${v} ${license}`)))
    .sort();
}
