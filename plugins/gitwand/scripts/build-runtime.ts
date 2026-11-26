// Builds the GitWand runtime archive for one platform: the gitwand-bridge
// binary and the GitWand UI, from a pinned upstream commit plus this plugin's
// patches and bridge sources.
//
//   node scripts/build-runtime.ts --tag v3.14.0 --commit <sha> --platform darwin-arm64
//        [--build 1] [--out <dir>] [--cargo-home <dir>]
//
// Upstream is cloned into a new empty directory under $TMPDIR and its install
// and build scripts run only there. The tag and commit must match
// upstream.lock.json, and the tag must point at the commit on the remote. The
// build stops when a patch does not apply, when a command needs an adapter
// that does not exist, when the UI names a Tauri plugin command the shim does
// not know, or when the UI still loads grammars from an absolute path.
//
// Output (default plugins/gitwand/.runtime/): the archive, and the same tree
// unpacked as <version>-<platform>/ with current.json pointing at it, which
// the bridge contract tests use.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_PLUGIN_COMMANDS } from "../src/core/tauri-plugin-commands.ts";
import { UI_BASE_PATH } from "../src/core/ui-routes.ts";
import { generateFor } from "./gen-bridge-dispatch.ts";
import { archiveName, jsLicenseLines, manifestText, parseBuildArgs, shippedCrates, type CargoMetadata, runtimeVersion, scanPluginCommands, unknownPluginCommands, type Platform } from "./lib/runtime-build.ts";

const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
const step = (message: string): void => console.error(`[build-runtime ${Math.round((Date.now() - started) / 1000)}s] ${message}`);

function run(command: string, args: string[], options: SpawnSyncOptions = {}): string {
  const r = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${r.status}`);
  return String(r.stdout ?? "");
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

function hostPlatform(): Platform | null {
  const key = `${process.platform}-${process.arch}`;
  return ({ "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "linux-x64": "linux-x64" } as const)[key as "darwin-arm64"] ?? null;
}

function main(): void {
  const args = parseBuildArgs(process.argv.slice(2));
  const lock = JSON.parse(readFileSync(join(PLUGIN, "upstream.lock.json"), "utf8"));
  if (args.tag !== lock.tag || args.commit !== lock.commit) throw new Error(`--tag/--commit must match upstream.lock.json (${lock.tag} ${lock.commit})`);
  if (hostPlatform() !== args.platform) throw new Error(`this host builds ${hostPlatform()}, not ${args.platform} (no cross builds)`);
  const version = runtimeVersion(args.tag, args.build);

  const work = mkdtempSync(join(tmpdir(), "gitwand-build-"));
  const src = join(work, "gitwand");
  const cache = join(work, "cache");
  step(`work directory ${work}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_cache: join(cache, "npm"),
    npm_config_store_dir: join(cache, "pnpm-store"),
    XDG_CACHE_HOME: join(cache, "xdg"),
    COREPACK_ENABLE_STRICT: "0",
    CI: "1",
    CARGO_HOME: args.cargoHome ?? join(cache, "cargo"),
    GITWAND_COMMIT: args.commit,
    GITWAND_RUNTIME_VERSION: version,
  };

  // 1. Upstream at the pinned commit, in an empty directory.
  mkdirSync(src);
  const git = (...a: string[]): string => run("git", a, { cwd: src, env });
  git("init", "-q");
  git("remote", "add", "origin", lock.repo);
  const remoteTag = git("ls-remote", "origin", `refs/tags/${args.tag}`, `refs/tags/${args.tag}^{}`)
    .trim()
    .split("\n")
    .map((l) => l.split("\t"));
  const tagCommit = (remoteTag.find(([, ref]) => ref.endsWith("^{}")) ?? remoteTag[0])?.[0];
  if (tagCommit !== args.commit) throw new Error(`${args.tag} points at ${tagCommit ?? "nothing"} on ${lock.repo}, not ${args.commit}`);
  git("fetch", "-q", "--depth", "1", "origin", args.commit);
  git("checkout", "-q", "FETCH_HEAD");
  if (git("rev-parse", "HEAD").trim() !== args.commit) throw new Error("checked-out commit differs from --commit");
  step(`upstream ${args.tag} at ${args.commit}`);

  // 2. Patches, verified against the lock before they touch the tree.
  for (const patch of lock.patches as { name: string; sha256: string }[]) {
    const path = join(PLUGIN, "patches", patch.name);
    if (sha256(path) !== patch.sha256) throw new Error(`${patch.name} differs from upstream.lock.json`);
    git("apply", "--check", path);
    git("apply", path);
  }
  step("patches applied");

  // 3. Bridge sources and the generated dispatcher.
  const srcTauri = join(src, "apps/desktop/src-tauri");
  cpSync(join(PLUGIN, "bridge-src"), srcTauri, { recursive: true });
  const dispatch = generateFor(srcTauri);
  writeFileSync(join(srcTauri, "src/bridge/dispatch.rs"), dispatch.code);
  step(`dispatcher: ${dispatch.generated} generated of ${dispatch.handlers} commands`);

  // 4. UI, served from the plugin's route.
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)/.exec(JSON.parse(readFileSync(join(src, "package.json"), "utf8")).packageManager ?? "")?.[1];
  if (pnpmVersion === undefined) throw new Error("upstream package.json does not pin pnpm in packageManager");
  const pnpm = (cwd: string, ...a: string[]): string => run("npm", ["exec", "--yes", `pnpm@${pnpmVersion}`, "--", ...a], { cwd, env });
  pnpm(src, "install", "--frozen-lockfile");
  pnpm(src, "--filter", "@gitwand/core", "build");
  const desktop = join(src, "apps/desktop");
  run("node", ["scripts/copy-grammars.mjs"], { cwd: desktop, env });
  run(join(desktop, "node_modules/.bin/vite"), ["build", `--base=${UI_BASE_PATH}/`], { cwd: desktop, env });
  const dist = join(desktop, "dist");
  const bundle = filesUnder(join(dist, "assets"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const pluginCommands = scanPluginCommands(bundle);
  const unknown = unknownPluginCommands(pluginCommands, KNOWN_PLUGIN_COMMANDS);
  if (unknown.length > 0) throw new Error(`the UI invokes Tauri plugin commands the shim does not know: ${unknown.join(", ")}`);
  if (/["'`]\/grammars\//.test(bundle)) throw new Error("the UI still loads /grammars from an absolute path (patch 0002 ineffective)");
  step(`UI built: ${filesUnder(dist).length} files, ${pluginCommands.length} plugin commands, all known`);

  // 5. gitwand-bridge.
  run("cargo", ["build", "--release", "--locked", "--example", "gitwand-bridge", "--features", "bridge"], { cwd: srcTauri, env });
  const bin = join(srcTauri, "target/release/examples/gitwand-bridge");
  const identity = run(bin, ["--version"], { env }).trim();
  if (identity !== `gitwand-bridge ${version} (${args.commit}) commands=${dispatch.generated}`) throw new Error(`unexpected --version output: ${identity}`);
  step(`bridge built: ${identity}`);

  // 6. Licenses of what is shipped.
  const triple = run("rustc", ["-vV"], { env }).match(/^host: (\S+)$/m)?.[1];
  if (triple === undefined) throw new Error("rustc -vV did not report the host triple");
  const crates = shippedCrates(
    JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--locked", "--features", "bridge", "--filter-platform", triple], { cwd: srcTauri, env })) as CargoMetadata,
  );
  const jsLicenses = run("npm", ["exec", "--yes", `pnpm@${pnpmVersion}`, "--", "licenses", "list", "--prod", "--json"], { cwd: desktop, env });
  const notices = [
    "GitWand runtime for the Makosh GitWand plugin for BB.",
    `Built from ${lock.repo} ${args.tag} (${args.commit}) with the plugin's patches.`,
    "",
    "== GitWand (MIT) ==",
    readFileSync(join(src, "LICENSE"), "utf8").trim(),
    "",
    `== Rust crates linked into gitwand-bridge for ${triple} (name version license) ==`,
    ...crates,
    "",
    "== JavaScript packages of the UI (pnpm licenses list --prod: name version license) ==",
    ...jsLicenseLines(jsLicenses),
    "",
  ].join("\n");

  // 7. Stage, manifest, archive.
  const name = `gitwand-runtime-${version}-${args.platform}`;
  const stage = join(work, "stage", name);
  mkdirSync(join(stage, "bin"), { recursive: true });
  cpSync(bin, join(stage, "bin/gitwand-bridge"));
  cpSync(dist, join(stage, "ui"), { recursive: true });
  cpSync(join(src, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(join(stage, "NOTICES"), notices);
  writeFileSync(
    join(stage, "runtime.json"),
    JSON.stringify({ version, gitwandTag: args.tag, commit: args.commit, platform: args.platform, protocol: 1, generated: dispatch.generated, adapted: 5, pluginCommands }, null, 2) + "\n",
  );
  writeFileSync(join(stage, "MANIFEST.sha256"), manifestText(filesUnder(stage).map((f) => ({ path: relative(stage, f), sha256: sha256(f) }))));
  const out = args.out ?? join(PLUGIN, ".runtime");
  mkdirSync(out, { recursive: true });
  const archive = join(out, archiveName(version, args.platform));
  // Neutral owner: the build machine's user name stays out of the archive.
  run("tar", ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "wheel", "-czf", archive, "-C", join(work, "stage"), name], { env: { ...env, COPYFILE_DISABLE: "1" } });
  const unpacked = join(out, `${version}-${args.platform}`);
  rmSync(unpacked, { recursive: true, force: true });
  cpSync(stage, unpacked, { recursive: true });
  writeFileSync(join(out, "current.json"), JSON.stringify({ dir: unpacked, version, platform: args.platform }, null, 2) + "\n");

  console.log(
    JSON.stringify(
      {
        version,
        archive,
        sha256: sha256(archive),
        archiveBytes: statSync(archive).size,
        bridgeBytes: statSync(bin).size,
        generated: dispatch.generated,
        handlers: dispatch.handlers,
        uiFiles: filesUnder(join(stage, "ui")).length,
        pluginCommands: pluginCommands.length,
        seconds: Math.round((Date.now() - started) / 1000),
        work,
      },
      null,
      2,
    ),
  );
  if (!existsSync(unpacked)) throw new Error("unpacked runtime missing");
}

try {
  main();
} catch (error) {
  console.error(`build-runtime: ${(error as Error).message}`);
  process.exit(1);
}
