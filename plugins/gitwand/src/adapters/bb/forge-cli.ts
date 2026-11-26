// Remote repositories from the forge CLIs the user is signed in to:
//   gh   — every account in gh's keyring (`gh auth status --json hosts`), each
//          listed with its own token (`gh auth token --user`), passed to that
//          one `gh api` call through its environment only;
//   glab — the projects the user is a member of, per configured GitLab host.
// Tokens never leave this module: results carry fixed error messages, never a
// CLI's output.
import { z } from "zod";
import { GH_REPO_JQ, parseGhRepos, parseGlabProjects, type GitProtocol, type RemoteSource, type RemoteSourceResult } from "../../core/repo-catalog.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a CLI; resolves with its exit code instead of throwing. */
export type Exec = (cmd: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

export interface ForgeListerOptions {
  exec: Exec;
  /** The server's environment for the CLIs. */
  env: () => NodeJS.ProcessEnv;
  has: (tool: "gh" | "glab") => boolean;
  gitlabHosts: string[];
  now: () => Date;
}

const AUTH_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 120_000;
const GH_REPOS = "user/repos?per_page=100&affiliation=owner,organization_member";
const GLAB_PROJECTS = "projects?membership=true&per_page=100&order_by=last_activity_at";
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

const ghAuth = z.object({
  hosts: z.record(
    z.string(),
    z.array(z.object({ state: z.string(), host: z.string().min(1), login: z.string().min(1), gitProtocol: z.string().optional() })),
  ),
});

function withoutTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of TOKEN_VARS) delete out[name];
  return out;
}

const protocolOf = (value: string | undefined): GitProtocol => (value?.trim() === "ssh" ? "ssh" : "https");

function failed(source: RemoteSource, error: string): RemoteSourceResult {
  return { source, ok: false, error, fetchedAt: null, repos: [] };
}

async function githubSources(o: ForgeListerOptions): Promise<RemoteSourceResult[]> {
  const fallback: RemoteSource = { id: "github.com", kind: "github", host: "github.com", account: null };
  if (!o.has("gh")) return [failed(fallback, "gh is not installed")];
  const env = withoutTokens(o.env());
  const status = await o.exec("gh", ["auth", "status", "--json", "hosts"], { env, timeoutMs: AUTH_TIMEOUT_MS });
  // gh exits 1 when one account has a problem and still prints every account.
  let auth: z.infer<typeof ghAuth>;
  try {
    auth = ghAuth.parse(JSON.parse(status.stdout));
  } catch {
    return [failed(fallback, status.timedOut ? "gh did not answer in time" : "gh did not list its accounts; check gh auth status")];
  }
  const accounts = Object.values(auth.hosts).flat();
  if (accounts.length === 0) return [failed(fallback, "gh is not signed in to any account: gh auth login")];

  return Promise.all(
    accounts.map(async (account): Promise<RemoteSourceResult> => {
      const source: RemoteSource = { id: `${account.host}/${account.login}`, kind: "github", host: account.host, account: account.login };
      if (account.state !== "success") return failed(source, `gh needs a new sign-in for ${account.login}: gh auth login`);
      const token = await o.exec("gh", ["auth", "token", "--hostname", account.host, "--user", account.login], { env, timeoutMs: AUTH_TIMEOUT_MS });
      const value = token.stdout.trim();
      if (token.code !== 0 || value === "") return failed(source, `gh could not give the token of ${account.login}`);
      const tokenEnv = { ...env, [account.host === "github.com" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"]: value };
      const list = await o.exec("gh", ["api", "--hostname", account.host, "--paginate", GH_REPOS, "--jq", GH_REPO_JQ], { env: tokenEnv, timeoutMs: LIST_TIMEOUT_MS });
      if (list.timedOut) return failed(source, `gh did not answer in time for ${account.login}`);
      if (list.code !== 0) return failed(source, `gh could not list the repositories of ${account.login} (exit ${list.code})`);
      return { source, ok: true, error: null, fetchedAt: o.now().toISOString(), repos: parseGhRepos(list.stdout, { host: account.host, protocol: protocolOf(account.gitProtocol) }) };
    }),
  );
}

async function gitlabSource(o: ForgeListerOptions, host: string): Promise<RemoteSourceResult> {
  const source: RemoteSource = { id: host, kind: "gitlab", host, account: null };
  if (!o.has("glab")) return failed(source, "glab is not installed");
  const env = o.env();
  const proto = await o.exec("glab", ["config", "get", "git_protocol", "--host", host], { env, timeoutMs: AUTH_TIMEOUT_MS });
  const list = await o.exec("glab", ["api", "--hostname", host, "--paginate", "--output", "ndjson", GLAB_PROJECTS], { env, timeoutMs: LIST_TIMEOUT_MS });
  if (list.timedOut) return failed(source, `glab did not answer in time for ${host}`);
  if (list.code !== 0) return failed(source, `glab could not list the projects on ${host} (exit ${list.code}); check glab auth status`);
  return { source, ok: true, error: null, fetchedAt: o.now().toISOString(), repos: parseGlabProjects(list.stdout, { host, protocol: protocolOf(proto.code === 0 ? proto.stdout : undefined) }) };
}

export async function listRemoteSources(o: ForgeListerOptions): Promise<RemoteSourceResult[]> {
  const [github, gitlab] = await Promise.all([githubSources(o), Promise.all(o.gitlabHosts.map((host) => gitlabSource(o, host)))]);
  return [...github, ...gitlab];
}
