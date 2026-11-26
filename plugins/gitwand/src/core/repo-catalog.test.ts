import { describe, expect, it } from "vitest";
import { buildCatalog, GH_REPO_JQ, mergeRemoteResults, parseGhRepos, parseGlabProjects, type RemoteSourceResult } from "./repo-catalog.ts";

const ghLine = (o: Record<string, unknown>) =>
  JSON.stringify({
    full_name: "Example/one",
    description: "First",
    private: true,
    archived: false,
    fork: false,
    ssh_url: "git@github.com:Example/one.git",
    clone_url: "https://github.com/Example/one.git",
    html_url: "https://github.com/Example/one",
    pushed_at: "2026-11-20T10:00:00Z",
    ...o,
  });

describe("parseGhRepos", () => {
  it("reads one repository per line and picks the URL for the account's git protocol", () => {
    const text = `${ghLine({})}\n${ghLine({ full_name: "org/two", description: null, private: false, ssh_url: "git@github.com:org/two.git", clone_url: "https://github.com/org/two.git", html_url: "https://github.com/org/two" })}\n`;
    expect(parseGhRepos(text, { host: "github.com", protocol: "ssh" })).toEqual([
      { fullName: "Example/one", description: "First", private: true, archived: false, fork: false, cloneUrl: "git@github.com:Example/one.git", webUrl: "https://github.com/Example/one", updatedAt: "2026-11-20T10:00:00Z" },
      { fullName: "org/two", description: null, private: false, archived: false, fork: false, cloneUrl: "git@github.com:org/two.git", webUrl: "https://github.com/org/two", updatedAt: "2026-11-20T10:00:00Z" },
    ]);
    expect(parseGhRepos(ghLine({}), { host: "github.com", protocol: "https" })[0]!.cloneUrl).toBe("https://github.com/Example/one.git");
  });

  it("skips lines that are not repositories", () => {
    expect(parseGhRepos(`not json\n{"full_name":5}\n\n${ghLine({})}`, { host: "github.com", protocol: "https" }).map((r) => r.fullName)).toEqual(["Example/one"]);
  });

  it("asks gh only for the fields it reads", () => {
    expect(GH_REPO_JQ).toBe(".[] | {full_name, description, private, archived, fork, ssh_url, clone_url, html_url, pushed_at}");
  });
});

describe("parseGlabProjects", () => {
  it("reads GitLab projects from ndjson", () => {
    const line = JSON.stringify({
      path_with_namespace: "group/sub/proj",
      description: "",
      visibility: "private",
      archived: false,
      ssh_url_to_repo: "git@gitlab.com:group/sub/proj.git",
      http_url_to_repo: "https://gitlab.com/group/sub/proj.git",
      web_url: "https://gitlab.com/group/sub/proj",
      last_activity_at: "2026-11-01T00:00:00.000Z",
      forked_from_project: { id: 1 },
    });
    expect(parseGlabProjects(line, { host: "gitlab.com", protocol: "https" })).toEqual([
      { fullName: "group/sub/proj", description: null, private: true, archived: false, fork: true, cloneUrl: "https://gitlab.com/group/sub/proj.git", webUrl: "https://gitlab.com/group/sub/proj", updatedAt: "2026-11-01T00:00:00.000Z" },
    ]);
  });

  it("treats public and internal projects by visibility and a missing archived flag as not archived", () => {
    const line = JSON.stringify({ path_with_namespace: "g/p", visibility: "public", ssh_url_to_repo: "git@gitlab.com:g/p.git", http_url_to_repo: "https://gitlab.com/g/p.git", web_url: "https://gitlab.com/g/p" });
    expect(parseGlabProjects(line, { host: "gitlab.com", protocol: "ssh" })[0]).toMatchObject({ private: false, archived: false, fork: false, cloneUrl: "git@gitlab.com:g/p.git", updatedAt: null });
  });
});

describe("buildCatalog", () => {
  const sources: RemoteSourceResult[] = [
    {
      source: { id: "github.com/Example", kind: "github", host: "github.com", account: "Example" },
      ok: true,
      error: null,
      fetchedAt: "2026-11-26T09:00:00.000Z",
      repos: [
        { fullName: "Example/One", description: null, private: true, archived: false, fork: false, cloneUrl: "git@github.com:Example/One.git", webUrl: "https://github.com/Example/One", updatedAt: null },
        { fullName: "Example/two", description: null, private: false, archived: false, fork: false, cloneUrl: "git@github.com:Example/two.git", webUrl: "https://github.com/Example/two", updatedAt: null },
      ],
    },
    {
      source: { id: "github.com/Other", kind: "github", host: "github.com", account: "Other" },
      ok: true,
      error: null,
      fetchedAt: "2026-11-26T09:00:00.000Z",
      repos: [{ fullName: "Example/two", description: null, private: false, archived: false, fork: false, cloneUrl: "git@github.com:Example/two.git", webUrl: "https://github.com/Example/two", updatedAt: null }],
    },
    { source: { id: "gitlab.com", kind: "gitlab", host: "gitlab.com", account: null }, ok: false, error: "glab is not signed in to gitlab.com", fetchedAt: null, repos: [] },
  ];
  const local = [
    { path: "/p/one", name: "one", root: "/p", remotes: ["https://github.com/example/one"], keys: ["github.com/example/one"] },
    { path: "/p/scratch", name: "scratch", root: "/p", remotes: [], keys: [] },
  ];

  it("marks remote repositories that are already cloned and lists each repository once", () => {
    const c = buildCatalog({ local, sources });
    expect(c.local).toEqual([
      { path: "/p/one", name: "one", remote: "github.com/example/one" },
      { path: "/p/scratch", name: "scratch", remote: null },
    ]);
    expect(c.remote.map((r) => [r.id, r.sources, r.localPath])).toEqual([
      ["github.com/example/one", ["github.com/Example"], "/p/one"],
      ["github.com/example/two", ["github.com/Example", "github.com/Other"], null],
    ]);
  });

  it("reports every source with its count and error", () => {
    const c = buildCatalog({ local, sources });
    expect(c.sources).toEqual([
      { id: "github.com/Example", kind: "github", host: "github.com", account: "Example", ok: true, error: null, count: 2, fetchedAt: "2026-11-26T09:00:00.000Z" },
      { id: "github.com/Other", kind: "github", host: "github.com", account: "Other", ok: true, error: null, count: 1, fetchedAt: "2026-11-26T09:00:00.000Z" },
      { id: "gitlab.com", kind: "gitlab", host: "gitlab.com", account: null, ok: false, error: "glab is not signed in to gitlab.com", count: 0, fetchedAt: null },
    ]);
  });
});

describe("mergeRemoteResults", () => {
  const src = { id: "github.com/Example", kind: "github" as const, host: "github.com", account: "Example" };
  const repo = { fullName: "Example/one", description: null, private: false, archived: false, fork: false, cloneUrl: "u", webUrl: "w", updatedAt: null };

  it("keeps the last repositories of a source that failed this time", () => {
    const merged = mergeRemoteResults(
      [{ source: src, ok: true, error: null, fetchedAt: "2026-11-25T00:00:00.000Z", repos: [repo] }],
      [{ source: src, ok: false, error: "gh did not answer in time for Example", fetchedAt: null, repos: [] }],
    );
    expect(merged).toEqual([{ source: src, ok: false, error: "gh did not answer in time for Example", fetchedAt: "2026-11-25T00:00:00.000Z", repos: [repo] }]);
  });

  it("drops sources that are gone and takes fresh results as they are", () => {
    const other = { ...src, id: "github.com/Gone", account: "Gone" };
    const fresh = { source: src, ok: true, error: null, fetchedAt: "2026-11-26T00:00:00.000Z", repos: [] };
    expect(mergeRemoteResults([{ source: other, ok: true, error: null, fetchedAt: "x", repos: [repo] }], [fresh])).toEqual([fresh]);
  });
});
