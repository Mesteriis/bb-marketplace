// Remote keys and config remotes ported from GitWand gitwand/v0.2.0 src/core/git-remotes.test.ts (MIT); the catalog tests are new.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog, categoriesOf, clonePath, keepFailedSources, parseConfigRemotes, remoteKey, type CatalogSource } from "../src/core/catalog/catalog.ts";

test("a remote URL becomes host/path, lower case, for SSH, HTTPS and Azure's two forms", () => {
  const cases: [string, string][] = [
    ["git@github.com:Mesteriis/GitWand-bb.git", "github.com/mesteriis/gitwand-bb"],
    ["https://github.com/Mesteriis/GitWand-bb.git", "github.com/mesteriis/gitwand-bb"],
    ["https://github.com/Mesteriis/GitWand-bb", "github.com/mesteriis/gitwand-bb"],
    ["ssh://git@github.com/Mesteriis/GitWand-bb.git", "github.com/mesteriis/gitwand-bb"],
    ["ssh://git@gitlab.example.org:2222/group/sub/proj.git", "gitlab.example.org/group/sub/proj"],
    ["git@gitlab.com:group/sub/proj.git", "gitlab.com/group/sub/proj"],
    ["git@ssh.dev.azure.com:v3/Org/Web/app", "dev.azure.com/org/web/_git/app"],
    ["https://dev.azure.com/Org/Web/_git/app", "dev.azure.com/org/web/_git/app"],
  ];
  for (const [url, key] of cases) assert.equal(remoteKey(url), key, url);
  for (const url of ["", "/Users/someone/bare.git", "../relative.git", "file:///tmp/x.git", "github.com", "https://user:secret@github.com/a/b.git"]) assert.equal(remoteKey(url), null, url);
});

test("every remote url of a git config is read, other sections ignored", () => {
  const config = ["[core]", "\trepositoryformatversion = 0", "\turl = not-a-remote", '[remote "origin"]', "\turl = git@github.com:example/one.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*", '[branch "main"]', "\tremote = origin", '[remote "upstream"]', "  url=https://gitlab.com/group/two.git", ""].join("\n");
  assert.deepEqual(parseConfigRemotes(config), ["git@github.com:example/one.git", "https://gitlab.com/group/two.git"]);
  assert.deepEqual(parseConfigRemotes("[core]\n\tbare = false\n"), []);
});

const repo = (accountId: string, path: string, clone: string) => ({id: accountId + ":" + path, accountId, project: path.split("/")[0]!, name: path.split("/").pop()!, path, clone, branch: "main", canPush: true});
const source = (id: string, kind: CatalogSource["account"]["kind"], repos: ReturnType<typeof repo>[], ok = true): CatalogSource =>
  ({account: {id, label: id.toUpperCase(), kind}, ok, error: ok ? null : "PROVIDER_UNAVAILABLE", fetchedAt: ok ? "2026-11-27T10:00:00Z" : null, repos});

test("local projects and every account's repositories make one catalog; a repository two accounts see is one row, marked cloned", () => {
  const local = [{path: "/p/Personal/app", name: "app", remotes: ["git@github.com:Owner/App.git"]}, {path: "/p/scratch", name: "scratch", remotes: []}];
  const catalog = buildCatalog(local, [
    source("gh", "github", [repo("gh", "owner/app", "https://github.com/owner/app.git"), repo("gh", "owner/lib", "https://github.com/owner/lib.git")]),
    source("gh2", "github", [repo("gh2", "owner/app", "https://github.com/owner/app.git")]),
  ]);
  assert.deepEqual(catalog.local, [{path: "/p/Personal/app", name: "app", key: "github.com/owner/app"}, {path: "/p/scratch", name: "scratch", key: null}]);
  assert.deepEqual(catalog.remote.map(row => [row.key, row.accounts, row.localPath]),
    [["github.com/owner/app", ["gh", "gh2"], "/p/Personal/app"], ["github.com/owner/lib", ["gh"], null]]);
  assert.deepEqual(catalog.sources.map(row => [row.id, row.ok, row.count]), [["gh", true, 2], ["gh2", true, 1]]);
});

test("a source that fails keeps the repositories it listed last time and says it failed", () => {
  const before = [source("gh", "github", [repo("gh", "o/a", "https://github.com/o/a.git")])];
  const now = keepFailedSources(before, [source("gh", "github", [], false), source("gl", "gitlab", [])]);
  assert.deepEqual(now.map(row => [row.account.id, row.ok, row.repos.length, row.fetchedAt]), [["gh", false, 1, "2026-11-27T10:00:00Z"], ["gl", true, 0, "2026-11-27T10:00:00Z"]]);
});

test("categories are the folders that hold projects; a clone goes into one, with a checked name", () => {
  assert.deepEqual(categoriesOf("/p", ["/p/OSS/tool", "/p/Personal/app", "/p/Work/team/svc", "/p/hass", "/p/Work/team/other"]), ["", "OSS", "Personal", "Work/team"]);
  assert.equal(clonePath("/p", "Work/team", "svc-2"), "/p/Work/team/svc-2");
  assert.equal(clonePath("/p", "", "app"), "/p/app");
  for (const [category, name] of [["../x", "a"], ["OSS", "../a"], ["OSS", ".hidden"], ["/abs", "a"], ["OSS", "a/b"], ["OSS", ""]]) assert.equal(clonePath("/p", category!, name!), null, category + " " + name);
});
