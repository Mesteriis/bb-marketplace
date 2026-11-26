// Installed GitWand runtimes under the plugin's data directory:
//   <root>/<version>-<platform>/   one unpacked archive per build
//   <root>/state.json              {"current": version, "previous": version | null}
// A build becomes current only after its archive matched the channel's size
// and sha256, every file matched MANIFEST.sha256, and a smoke test passed.
// The current and previous builds are kept; older ones are removed.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, constants, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isSafeRelativePath } from "../../core/ui-routes.ts";
import type { RuntimePlatform } from "../../core/versions.ts";

export interface InstalledRuntime {
  dir: string;
  version: string;
  commit: string;
  bin: string;
  uiDir: string;
}

export interface RuntimeArchive {
  version: string;
  url: string;
  sha256: string;
  size: number;
}

const runtimeJson = z.object({
  version: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  platform: z.string(),
  protocol: z.number(),
});

const stateJson = z.object({ current: z.string().nullable(), previous: z.string().nullable() });
type State = z.infer<typeof stateJson>;

const run = promisify(execFile);

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

export class RuntimeStore {
  constructor(
    private readonly options: {
      root: string;
      platform: RuntimePlatform;
      fetch?: typeof fetch;
      /** Starts the candidate build and checks it answers; throws to refuse it. */
      smoke?: (runtime: InstalledRuntime) => Promise<void>;
    },
  ) {}

  /** Checks a runtime tree against its manifest and this host. */
  async verify(dir: string): Promise<InstalledRuntime> {
    const manifest = (await readFile(join(dir, "MANIFEST.sha256"), "utf8")).split("\n").filter((l) => l !== "");
    const listed = new Set<string>();
    for (const line of manifest) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (m === null) throw new Error(`MANIFEST.sha256 has a malformed line: ${line.slice(0, 80)}`);
      const path = m[2];
      if (!isSafeRelativePath(path)) throw new Error(`MANIFEST.sha256 names an unsafe path: ${path}`);
      listed.add(path);
      const full = join(dir, ...path.split("/"));
      const info = await lstat(full).catch(() => null);
      if (info === null) throw new Error(`${path} is missing`);
      if (!info.isFile()) throw new Error(`${path} is not a regular file`);
      if ((await sha256(full)) !== m[1]) throw new Error(`${path} does not match MANIFEST.sha256`);
    }
    for (const file of await listFiles(dir)) {
      const path = relative(dir, file).split(sep).join("/");
      if (path === "MANIFEST.sha256") continue;
      if (!listed.has(path)) {
        const info = await lstat(file);
        throw new Error(info.isFile() ? `${path} is not in MANIFEST.sha256` : `${path} is not a regular file`);
      }
    }
    const meta = runtimeJson.parse(JSON.parse(await readFile(join(dir, "runtime.json"), "utf8")));
    if (meta.platform !== this.options.platform) throw new Error(`runtime is built for ${meta.platform}, this host is ${this.options.platform}`);
    const bin = join(dir, "bin", "gitwand-bridge");
    await access(bin, constants.X_OK).catch(() => {
      throw new Error("bin/gitwand-bridge is not executable");
    });
    return { dir, version: meta.version, commit: meta.commit, bin, uiDir: join(dir, "ui") };
  }

  async versions(): Promise<State> {
    try {
      return stateJson.parse(JSON.parse(await readFile(join(this.options.root, "state.json"), "utf8")));
    } catch {
      return { current: null, previous: null };
    }
  }

  async current(): Promise<InstalledRuntime | null> {
    const { current } = await this.versions();
    return current === null ? null : this.verify(this.dirOf(current));
  }

  /** Downloads and installs a build; the current one stays if any step fails. */
  async install(archive: RuntimeArchive): Promise<InstalledRuntime> {
    const fetchImpl = this.options.fetch ?? fetch;
    await mkdir(this.options.root, { recursive: true });
    const tmp = join(this.options.root, `.tmp-${randomBytes(6).toString("hex")}`);
    await mkdir(join(tmp, "x"), { recursive: true });
    try {
      const response = await fetchImpl(archive.url);
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== archive.size) throw new Error(`archive is ${bytes.length} bytes, the channel promised ${archive.size}`);
      if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) throw new Error("archive sha256 does not match the channel");
      const file = join(tmp, "runtime.tar.gz");
      await writeFile(file, bytes);
      await run("tar", ["-xzf", file, "-C", join(tmp, "x")]);
      const top = await readdir(join(tmp, "x"));
      if (top.length !== 1) throw new Error("archive must hold exactly one runtime directory");
      const candidate = await this.verify(join(tmp, "x", top[0]));
      if (candidate.version !== archive.version) throw new Error(`archive holds ${candidate.version}, the channel promised ${archive.version}`);
      if (this.options.smoke) {
        try {
          await this.options.smoke(candidate);
        } catch (error) {
          throw new Error(`smoke test failed: ${(error as Error).message}`);
        }
      }
      const target = this.dirOf(candidate.version);
      await rm(target, { recursive: true, force: true });
      await rename(candidate.dir, target);
      const before = await this.versions();
      const previous = before.current !== null && before.current !== candidate.version ? before.current : before.previous;
      await this.writeState({ current: candidate.version, previous });
      await this.prune();
      return { ...candidate, dir: target, bin: join(target, "bin", "gitwand-bridge"), uiDir: join(target, "ui") };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async rollback(): Promise<void> {
    const { current, previous } = await this.versions();
    if (previous === null) throw new Error("There is no previous GitWand runtime to roll back to");
    await this.verify(this.dirOf(previous));
    await this.writeState({ current: previous, previous: current });
  }

  private dirOf(version: string): string {
    return join(this.options.root, `${version}-${this.options.platform}`);
  }

  private async writeState(state: State): Promise<void> {
    const file = join(this.options.root, "state.json");
    await writeFile(`${file}.new`, JSON.stringify(state) + "\n");
    await rename(`${file}.new`, file);
  }

  private async prune(): Promise<void> {
    const { current, previous } = await this.versions();
    const keep = new Set([current, previous].filter((v) => v !== null).map((v) => `${v}-${this.options.platform}`));
    for (const name of await readdir(this.options.root)) {
      if (name.endsWith(`-${this.options.platform}`) && !keep.has(name)) await rm(join(this.options.root, name), { recursive: true, force: true });
    }
  }
}

/** The development runtime directory when set (verified), else the installed build. */
export async function resolveRuntime(options: { devDir: string | null; store: RuntimeStore }): Promise<(InstalledRuntime & { source: "dev" | "installed" }) | null> {
  if (options.devDir) return { ...(await options.store.verify(options.devDir)), source: "dev" };
  const current = await options.store.current();
  return current === null ? null : { ...current, source: "installed" };
}
