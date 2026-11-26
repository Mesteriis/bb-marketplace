import { describe, expect, it } from "vitest";
import { listRemoteSources, type Exec } from "./forge-cli.ts";

const NOW = new Date("2026-11-26T09:00:00.000Z");
const repoLine = (name: string) =>
  JSON.stringify({ full_name: name, description: null, private: true, archived: false, fork: false, ssh_url: `git@github.com:${name}.git`, clone_url: `https://github.com/${name}.git`, html_url: `https://github.com/${name}`, pushed_at: null });

interface Call {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function fakeExec(answer: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => { code: number; stdout?: string; stderr?: string; timedOut?: boolean }) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    const r = answer(cmd, args, opts.env);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.timedOut ?? false };
  };
  return { exec, calls };
}

const AUTH = JSON.stringify({
  hosts: {
    "github.com": [
      { state: "success", active: true, host: "github.com", login: "First", gitProtocol: "ssh" },
      { state: "success", active: false, host: "github.com", login: "second", gitProtocol: "https" },
    ],
  },
});

function forges(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const a = args.join(" ");
  if (cmd === "gh" && a === "auth status --json hosts") return { code: 0, stdout: AUTH };
  if (cmd === "gh" && a === "auth token --hostname github.com --user First") return { code: 0, stdout: "tok-first\n" };
  if (cmd === "gh" && a === "auth token --hostname github.com --user second") return { code: 0, stdout: "tok-second\n" };
  if (cmd === "gh" && args[0] === "api") return { code: 0, stdout: env.GH_TOKEN === "tok-first" ? repoLine("First/a") : repoLine("org/b") };
  if (cmd === "glab" && a === "config get git_protocol --host gitlab.com") return { code: 0, stdout: "ssh\n" };
  if (cmd === "glab" && args[0] === "api")
    return { code: 0, stdout: JSON.stringify({ path_with_namespace: "g/p", visibility: "private", ssh_url_to_repo: "git@gitlab.com:g/p.git", http_url_to_repo: "https://gitlab.com/g/p.git", web_url: "https://gitlab.com/g/p" }) };
  return { code: 1, stderr: "unexpected" };
}

const base = { env: () => ({ PATH: "/bin", GITHUB_TOKEN: "pat-from-env", GH_TOKEN: "other", HOME: "/h" }), has: () => true, gitlabHosts: ["gitlab.com"], now: () => NOW };

describe("listRemoteSources", () => {
  it("lists every gh account's repositories with that account's own token", async () => {
    const { exec, calls } = fakeExec(forges);
    const sources = await listRemoteSources({ ...base, exec });
    expect(sources.map((s) => [s.source.id, s.ok, s.repos.map((r) => r.fullName)])).toEqual([
      ["github.com/First", true, ["First/a"]],
      ["github.com/second", true, ["org/b"]],
      ["gitlab.com", true, ["g/p"]],
    ]);
    const api = calls.filter((c) => c.cmd === "gh" && c.args[0] === "api");
    expect(api.map((c) => c.args)).toEqual([
      ["api", "--hostname", "github.com", "--paginate", "user/repos?per_page=100&affiliation=owner,organization_member", "--jq", ".[] | {full_name, description, private, archived, fork, ssh_url, clone_url, html_url, pushed_at}"],
      ["api", "--hostname", "github.com", "--paginate", "user/repos?per_page=100&affiliation=owner,organization_member", "--jq", ".[] | {full_name, description, private, archived, fork, ssh_url, clone_url, html_url, pushed_at}"],
    ]);
    expect(api.map((c) => [c.env.GH_TOKEN, c.env.GITHUB_TOKEN])).toEqual([
      ["tok-first", undefined],
      ["tok-second", undefined],
    ]);
    expect(sources[0]!.repos[0]!.cloneUrl).toBe("git@github.com:First/a.git");
    expect(sources[1]!.repos[0]!.cloneUrl).toBe("https://github.com/org/b.git");
    expect(sources[0]!.fetchedAt).toBe("2026-11-26T09:00:00.000Z");
  });

  it("asks gh about accounts and tokens without the tokens from the server's environment", async () => {
    const { exec, calls } = fakeExec(forges);
    await listRemoteSources({ ...base, exec });
    for (const c of calls.filter((c) => c.cmd === "gh" && c.args[0] === "auth")) {
      expect([c.env.GH_TOKEN, c.env.GITHUB_TOKEN, c.env.GH_ENTERPRISE_TOKEN]).toEqual([undefined, undefined, undefined]);
    }
  });

  it("never puts a token or a CLI's output into the result", async () => {
    const { exec } = fakeExec((cmd, args, env) => (cmd === "gh" && args[0] === "api" && env.GH_TOKEN === "tok-second" ? { code: 1, stderr: "HTTP 401: Bad credentials tok-second" } : forges(cmd, args, env)));
    const sources = await listRemoteSources({ ...base, exec });
    const text = JSON.stringify(sources);
    expect(text).not.toContain("tok-");
    expect(text).not.toContain("Bad credentials");
    expect(sources[1]).toMatchObject({ ok: false, error: "gh could not list the repositories of second (exit 1)", repos: [] });
  });

  it("uses GH_ENTERPRISE_TOKEN for an account on another host", async () => {
    const auth = JSON.stringify({ hosts: { "git.corp.example": [{ state: "success", host: "git.corp.example", login: "me", gitProtocol: "https" }] } });
    const { exec, calls } = fakeExec((cmd, args) => {
      const a = args.join(" ");
      if (a === "auth status --json hosts") return { code: 0, stdout: auth };
      if (a === "auth token --hostname git.corp.example --user me") return { code: 0, stdout: "tok-corp" };
      if (args[0] === "api") return { code: 0, stdout: "" };
      return { code: 1 };
    });
    const sources = await listRemoteSources({ ...base, exec, gitlabHosts: [] });
    expect(sources.map((s) => [s.source.id, s.ok])).toEqual([["git.corp.example/me", true]]);
    const api = calls.find((c) => c.args[0] === "api")!;
    expect([api.env.GH_ENTERPRISE_TOKEN, api.env.GH_TOKEN]).toEqual(["tok-corp", undefined]);
  });

  it("reports an account gh can no longer use", async () => {
    const auth = JSON.stringify({ hosts: { "github.com": [{ state: "error", host: "github.com", login: "stale" }] } });
    const { exec, calls } = fakeExec((cmd, args) => (args.join(" ") === "auth status --json hosts" ? { code: 1, stdout: auth } : { code: 1 }));
    const sources = await listRemoteSources({ ...base, exec, gitlabHosts: [] });
    expect(sources).toEqual([
      { source: { id: "github.com/stale", kind: "github", host: "github.com", account: "stale" }, ok: false, error: "gh needs a new sign-in for stale: gh auth login", fetchedAt: null, repos: [] },
    ]);
    expect(calls.map((c) => c.args[0])).toEqual(["auth"]);
  });

  it("reports missing tools and a host glab is not signed in to", async () => {
    const { exec } = fakeExec((cmd, args) => (cmd === "glab" && args[0] === "api" ? { code: 1, stderr: "401" } : { code: 0, stdout: "https" }));
    const sources = await listRemoteSources({ ...base, exec, has: (tool) => tool === "glab" });
    expect(sources.map((s) => [s.source.id, s.ok, s.error])).toEqual([
      ["github.com", false, "gh is not installed"],
      ["gitlab.com", false, "glab could not list the projects on gitlab.com (exit 1); check glab auth status"],
    ]);
  });

  it("says when a CLI did not answer in time", async () => {
    const { exec } = fakeExec((cmd, args, env) => (cmd === "glab" && args[0] === "api" ? { code: 1, timedOut: true } : forges(cmd, args, env)));
    const sources = await listRemoteSources({ ...base, exec });
    expect(sources[2]).toMatchObject({ ok: false, error: "glab did not answer in time for gitlab.com" });
  });

  it("asks glab for the projects the user is a member of", async () => {
    const { exec, calls } = fakeExec(forges);
    await listRemoteSources({ ...base, exec });
    expect(calls.find((c) => c.cmd === "glab" && c.args[0] === "api")!.args).toEqual([
      "api",
      "--hostname",
      "gitlab.com",
      "--paginate",
      "--output",
      "ndjson",
      "projects?membership=true&per_page=100&order_by=last_activity_at",
    ]);
  });
});
