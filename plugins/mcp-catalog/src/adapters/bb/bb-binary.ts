import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The plugin server is started by the BB app, so its PATH may lack `bb`.
 * `BB_CLI` wins, then the bundled daemon binary and the usual install paths.
 */
export function resolveBb(
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const candidates = [
    env.BB_CLI,
    join(home, "Library/Application Support/Makosh BB Backend/runtime/node_modules/bb-app/host-daemon/dist/bb"),
    "/opt/homebrew/bin/bb",
    "/usr/local/bin/bb",
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "" && exists(candidate)) return candidate;
  }
  return "bb";
}

/** Environment that points every `bb` call at the server this plugin runs in, never at another BB instance. */
export function bbEnv(base: NodeJS.ProcessEnv, server: { url: string; dataDir: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, BB_SERVER_URL: server.url, BB_DATA_DIR: server.dataDir };
  delete env.BB_THREAD_ID;
  delete env.BB_ENVIRONMENT_ID;
  delete env.BB_PROJECT_ID;
  return env;
}
