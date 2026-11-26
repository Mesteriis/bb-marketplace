import { access, constants, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type LauncherKind = "npm" | "pypi" | "oci";
export type LauncherResult = { ok: true; path: string } | { ok: false; message: string };

const BINARY: Record<LauncherKind, string> = { npm: "npx", pypi: "uvx", oci: "docker" };
const HINT: Record<LauncherKind, string> = {
  npm: "поставьте Node.js",
  pypi: "поставьте uv",
  oci: "поставьте Docker",
};

const SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface LauncherEnv {
  /** Directories searched in order; defaults to the standard ones, mise shims/installs and PATH. */
  dirs?: string[];
  home?: string;
  /** Fixed system directories tried first when `dirs` is not given. */
  system?: string[];
  path?: string;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function miseDirs(home: string): Promise<string[]> {
  const dirs = [join(home, ".local/share/mise/shims")];
  const installs = join(home, ".local/share/mise/installs");
  try {
    for (const tool of await readdir(installs)) {
      const versions = await readdir(join(installs, tool)).catch(() => []);
      for (const version of versions) dirs.push(join(installs, tool, version, "bin"));
    }
  } catch {
    // no mise
  }
  return dirs;
}

export function defaultDirs(home: string, path: string, system: string[]): Promise<string[]> {
  return miseDirs(home).then((mise) => [
    ...system,
    join(home, ".local/bin"),
    ...mise,
    ...path.split(delimiter).filter((entry) => entry !== ""),
  ]);
}

export async function checkLaunchers(kind: LauncherKind, env: LauncherEnv = {}): Promise<LauncherResult> {
  const binary = BINARY[kind];
  const dirs = env.dirs ?? (await defaultDirs(env.home ?? homedir(), env.path ?? process.env.PATH ?? "", env.system ?? SYSTEM_DIRS));
  for (const dir of dirs) {
    const candidate = join(dir, binary);
    if (await isExecutable(candidate)) return { ok: true, path: candidate };
  }
  return { ok: false, message: `не найден ${binary}: ${HINT[kind]}` };
}
