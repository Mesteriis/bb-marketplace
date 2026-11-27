import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { catalogGit, catalogLocal } from "../src/adapters/bb/catalog-host.ts";

let base: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=F", "-c", "user.email=f@example.invalid", ...args], {cwd, encoding: "utf8"});
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "catalog-host-")));
  mkdirSync(join(base, "projects/Personal/app"), {recursive: true});
  mkdirSync(join(base, "projects/Work/team/svc"), {recursive: true});
  mkdirSync(join(base, "outside"), {recursive: true});
  for (const folder of ["projects/Personal/app", "projects/Work/team/svc", "outside"]) {
    git(join(base, folder), "init", "-q", "-b", "main");
    writeFileSync(join(base, folder, "a.txt"), "a\n"); git(join(base, folder), "add", "."); git(join(base, folder), "commit", "-qm", "first");
  }
  git(join(base, "projects/Personal/app"), "remote", "add", "origin", "git@github.com:Owner/App.git");
  git(join(base, "projects/Work/team/svc"), "remote", "add", "origin", "work-gitlab:team/svc.git");
});
afterEach(() => rmSync(base, {recursive: true, force: true}));

test("the projects folder lists its projects with their remotes, an SSH alias written with its host", async () => {
  const listed = await catalogLocal(join(base, "projects"), [], undefined, async alias => alias === "work-gitlab" ? "gitlab.example.org" : "x");
  assert.equal(listed.root, join(base, "projects"));
  assert.deepEqual(listed.projects.map(project => [project.path.slice(base.length), project.name, project.remotes]), [
    ["/projects/Personal/app", "app", ["git@github.com:Owner/App.git"]],
    ["/projects/Work/team/svc", "svc", ["git@gitlab.example.org:team/svc"]],
  ]);
});

test("catalog Git works only inside the projects folder; an HTTPS origin without an account, or no forge origin, is refused", async () => {
  await assert.rejects(catalogGit(join(base, "projects"), join(base, "outside"), "status", null), {message: "OUTSIDE_PROJECTS"});
  await assert.rejects(catalogGit(join(base, "projects"), join(base, "projects"), "status", null), {message: "OUTSIDE_PROJECTS"});
  const status = await catalogGit(join(base, "projects"), join(base, "projects/Personal/app"), "status", null);
  assert.equal(status.branch, "main");
  // An HTTPS origin needs an account; a local path is no forge origin.
  git(join(base, "projects/Personal/app"), "remote", "set-url", "origin", "https://github.com/owner/app.git");
  await assert.rejects(catalogGit(join(base, "projects"), join(base, "projects/Personal/app"), "fetch", null), {message: "ACCOUNT_TRANSPORT_REQUIRED"});
  git(join(base, "projects/Personal/app"), "remote", "set-url", "origin", join(base, "outside"));
  await assert.rejects(catalogGit(join(base, "projects"), join(base, "projects/Personal/app"), "fetch", null), {message: "NO_ORIGIN"});
});
