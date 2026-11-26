// Where the GitWand UI iframe is loaded from. The same BB server is reached
// under the other loopback name, which the browser treats as a separate
// origin, so GitWand's localStorage and scripts stay apart from BB's page.

/** The plugin's HTTP namespace as the browser sees it. */
export const PLUGIN_HTTP_BASE = "/api/v1/plugins/makosh-gitwand/http";

/** The UI entry page inside that namespace. */
export const UI_INDEX_PATH = `${PLUGIN_HTTP_BASE}/ui/index.html`;

const SIBLING: Record<string, string> = { "127.0.0.1": "localhost", localhost: "127.0.0.1" };

/**
 * The iframe URL for a BB page open on `bbOrigin`, opening `repoPath` when
 * given. Null when BB is not on a plain http loopback origin: there is no
 * sibling origin to isolate the UI then.
 */
export function frameUrlFor(bbOrigin: string, repoPath: string | null): string | null {
  let url: URL;
  try {
    url = new URL(bbOrigin);
  } catch {
    return null;
  }
  const sibling = SIBLING[url.hostname];
  if (url.protocol !== "http:" || sibling === undefined || url.username !== "" || url.password !== "") return null;
  const port = url.port === "" ? "" : `:${url.port}`;
  const query = repoPath === null ? "" : `?repo=${encodeURIComponent(repoPath)}`;
  return `http://${sibling}${port}${UI_INDEX_PATH}${query}`;
}
