import test from "node:test";
import assert from "node:assert/strict";
import { parseRemote, sameRepository } from "../src/core/forge/remote-url.ts";

test("HTTPS remotes keep host and path without the .git suffix", () => {
  assert.deepEqual(parseRemote("https://github.com/o/r.git"), {transport: "https", host: "github.com", port: null, path: "o/r"});
  assert.deepEqual(parseRemote("https://dev.azure.com/org/proj/_git/r"), {transport: "https", host: "dev.azure.com", port: null, path: "org/proj/_git/r"});
});

test("scp-like SSH remotes keep an alias host as written", () => {
  assert.deepEqual(parseRemote("git@github-office:Org/r.git"), {transport: "ssh", host: "github-office", port: null, path: "Org/r"});
  assert.deepEqual(parseRemote("github.com:o/r"), {transport: "ssh", host: "github.com", port: null, path: "o/r"});
});

test("ssh:// remotes keep the port and nested groups", () => {
  assert.deepEqual(parseRemote("ssh://git@git.acme.example:2222/g/sub/r"), {transport: "ssh", host: "git.acme.example", port: 2222, path: "g/sub/r"});
  assert.deepEqual(parseRemote("ssh://git@GitLab.com/g/r.git/"), {transport: "ssh", host: "gitlab.com", port: null, path: "g/r"});
});

test("remotes with credentials, local paths and option-like hosts are rejected", () => {
  for (const value of ["https://user:pw@h.example/o/r", "https://token@h.example/o/r", "file:///x/r", "/abs/path", "../rel",
    "-oProxyCommand=x:o/r", "git@-oProxyCommand=x:o/r", "http://h.example/o/r", "https://h.example/", "https://h.example/o/r?x=1", "git@host:"]) {
    assert.equal(parseRemote(value), null, value);
  }
});

test("the same repository matches across transports and letter case", () => {
  const ssh = parseRemote("git@github.com:Mesteriis/Repo.git")!;
  const https = parseRemote("https://github.com/mesteriis/repo")!;
  assert.equal(sameRepository(ssh, https), true);
  assert.equal(sameRepository(ssh, parseRemote("https://github.com/mesteriis/other")!), false);
  assert.equal(sameRepository(ssh, parseRemote("https://gitlab.com/mesteriis/repo")!), false);
});
