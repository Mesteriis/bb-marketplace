import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { SLUG, type SecretsPort } from "../../core/inventory";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE = /([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)'\n/y;

/** Single-quotes a value for sh: `'` becomes `'\''`, nothing else is special. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parse(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  let at = 0;
  while (at < text.length) {
    LINE.lastIndex = at;
    const match = LINE.exec(text);
    if (match === null) throw new Error("файл ключей повреждён");
    values[match[1] as string] = (match[2] as string).replaceAll("'\\''", "'");
    at = LINE.lastIndex;
  }
  if (at < text.length) throw new Error("файл ключей повреждён");
  return values;
}

function requireSlug(slug: string): string {
  if (!SLUG.test(slug)) throw new Error("недопустимое имя сервера");
  return slug;
}

/** Secrets as `<dataDir>/env/<slug>.env`: 0600, written atomically, sourced by run.sh with `set -a; . file`. */
export class EnvFiles implements SecretsPort {
  constructor(private readonly dataDir: string) {}

  path(slug: string): string {
    return join(this.dataDir, "env", `${requireSlug(slug)}.env`);
  }

  private async read(slug: string): Promise<Record<string, string>> {
    try {
      return parse(await readFile(this.path(slug), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async state(slug: string): Promise<Record<string, "set" | "missing">> {
    const values = await this.read(slug);
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === "" ? "missing" : "set"]));
  }

  async write(slug: string, values: Record<string, string>): Promise<void> {
    for (const key of Object.keys(values)) {
      if (!KEY.test(key)) throw new Error("недопустимое имя переменной");
    }
    const merged = await this.read(slug);
    for (const [key, value] of Object.entries(values)) {
      if (value !== "") merged[key] = value;
    }
    await this.persist(slug, merged);
  }

  async clear(slug: string, keys: string[]): Promise<void> {
    for (const key of keys) {
      if (!KEY.test(key)) throw new Error("недопустимое имя переменной");
    }
    const current = await this.read(slug);
    const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key)));
    if (Object.keys(kept).length === Object.keys(current).length) return;
    await this.persist(slug, kept);
  }

  /** Replaces the whole file atomically: tmp file with 0600, then rename. */
  private async persist(slug: string, values: Record<string, string>): Promise<void> {
    const file = this.path(slug);
    const dir = join(this.dataDir, "env");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const text = Object.entries(values)
      .map(([key, value]) => `${key}=${shQuote(value)}\n`)
      .join("");
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async remove(slug: string): Promise<void> {
    await rm(this.path(slug), { force: true });
  }
}
