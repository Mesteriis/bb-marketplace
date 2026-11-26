// The repository catalog behind GitWand's "Repositories" dialog: scans the
// configured roots and caches the forge listing in the plugin's data
// directory. The forges are asked on the first catalog ever and on refresh only.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildCatalog, mergeRemoteResults, remoteCacheSchema, type Catalog, type RemoteSourceResult } from "../../core/repo-catalog.ts";
import { clampDepth, expandRoot, scanRepos, settingsList, type RootResult, type ScanFs, type ScanResult } from "../../core/repo-scan.ts";

export interface CatalogSettings {
  /** Roots as the user wrote them: comma or new-line separated, `~` allowed. */
  roots: string;
  depth: number;
}

export interface RepoCatalogServiceOptions {
  dataDir: string;
  home: string;
  fs: ScanFs;
  settings: () => Promise<CatalogSettings>;
  listRemote: () => Promise<RemoteSourceResult[]>;
  now?: () => Date;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A JSON file's value; null when it is missing, unreadable or not JSON. */
async function readJson(path: string): Promise<unknown> {
  const text = await readText(path).catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

export class RepoCatalogService {
  private readonly remotePath: string;
  private readonly now: () => Date;
  private remote: RemoteSourceResult[] | null = null;
  private remoteRun: Promise<RemoteSourceResult[]> | null = null;
  private scanRun: Promise<{ scan: ScanResult; roots: RootResult[]; at: string }> | null = null;

  constructor(private readonly o: RepoCatalogServiceOptions) {
    this.remotePath = join(o.dataDir, "catalog", "remote.json");
    this.now = o.now ?? (() => new Date());
  }

  /** Local repositories scanned now; remote ones from the cache (listed once if there is none). */
  async catalog(): Promise<Catalog> {
    const [local, remote] = await Promise.all([this.scan(), this.cachedRemote()]);
    return this.compose(local, remote);
  }

  /** Scans and lists every forge again. */
  async refresh(): Promise<Catalog> {
    const [local, remote] = await Promise.all([this.scan(), this.refreshRemote()]);
    return this.compose(local, remote);
  }

  private compose(local: Awaited<ReturnType<RepoCatalogService["scan"]>>, remote: RemoteSourceResult[]): Catalog {
    const built = buildCatalog({ local: local.scan.repos, sources: remote });
    return { ...built, roots: local.roots, truncated: local.scan.truncated, scannedAt: local.at };
  }

  private scan() {
    this.scanRun ??= this.runScan().finally(() => {
      this.scanRun = null;
    });
    return this.scanRun;
  }

  private async runScan() {
    const settings = await this.o.settings();
    const expanded = settingsList(settings.roots).map((raw) => ({ raw, root: expandRoot(raw, this.o.home) }));
    const scan = await scanRepos(this.o.fs, expanded.flatMap((e) => (e.root === null ? [] : [e.root])), clampDepth(settings.depth));
    const roots: RootResult[] = expanded.map((e) =>
      e.root === null ? { root: e.raw, ok: false } : (scan.roots.find((x) => x.root === e.root) ?? { root: e.root, ok: false }),
    );
    return { scan, roots, at: this.now().toISOString() };
  }

  private async loadRemoteCache(): Promise<RemoteSourceResult[] | null> {
    if (this.remote !== null) return this.remote;
    const parsed = remoteCacheSchema.safeParse(await readJson(this.remotePath));
    if (parsed.success) this.remote = parsed.data;
    return this.remote;
  }

  private async cachedRemote(): Promise<RemoteSourceResult[]> {
    if (this.remoteRun !== null) return this.remoteRun;
    return (await this.loadRemoteCache()) ?? this.refreshRemote();
  }

  private refreshRemote(): Promise<RemoteSourceResult[]> {
    this.remoteRun ??= (async () => {
      try {
        const previous = (await this.loadRemoteCache()) ?? [];
        const next = mergeRemoteResults(previous, await this.o.listRemote());
        this.remote = next;
        await writeAtomic(this.remotePath, JSON.stringify(next) + "\n").catch(() => undefined);
        return next;
      } finally {
        this.remoteRun = null;
      }
    })();
    return this.remoteRun;
  }
}
