import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { SLUG, type PackagesPort } from "../../core/inventory";

const EXECUTABLE = new Set(["bin/run.sh", "bin/shim.py"]);

function requireSlug(slug: string): string {
  if (!SLUG.test(slug)) throw new Error("недопустимое имя сервера");
  return slug;
}

function requireRelative(path: string): string {
  const clean = normalize(path);
  if (isAbsolute(clean) || clean === ".." || clean.startsWith("../")) throw new Error("недопустимый путь файла пакета");
  return clean;
}

/** Catalog packages as `<dataDir>/packages/<slug>/`, swapped in by rename so a half-written package is never visible. */
export class PackagesDir implements PackagesPort {
  constructor(private readonly dataDir: string) {}

  private dirOf(slug: string): string {
    return join(this.dataDir, "packages", requireSlug(slug));
  }

  async write(slug: string, files: Record<string, string>): Promise<string> {
    const target = this.dirOf(slug);
    const entries = Object.entries(files).map(([path, text]) => [requireRelative(path), text] as const);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      for (const [path, text] of entries) {
        const file = join(tmp, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
        await chmod(file, EXECUTABLE.has(path) ? 0o755 : 0o644);
      }
      await mkdir(tmp, { recursive: true });
      // rename cannot replace a non-empty directory, so the old one is moved aside first.
      const old = `${target}.old-${process.pid}-${Date.now()}`;
      let hadOld = true;
      try {
        await rename(target, old);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hadOld = false;
      }
      try {
        await rename(tmp, target);
      } catch (error) {
        if (hadOld) await rename(old, target).catch(() => undefined);
        throw error;
      }
      if (hadOld) await rm(old, { recursive: true, force: true });
    } catch (error) {
      await rm(tmp, { recursive: true, force: true });
      throw error;
    }
    return target;
  }

  async read(slug: string): Promise<Record<string, string> | null> {
    const root = this.dirOf(slug);
    const files: Record<string, string> = {};
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) files[path] = await readFile(join(root, path), "utf8");
      }
    };
    try {
      await walk("");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return files;
  }

  async remove(slug: string): Promise<void> {
    await rm(this.dirOf(slug), { recursive: true, force: true });
  }
}
