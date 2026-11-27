import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTarget } from "../src/core/pulls/pr-link.ts";

const accounts = [{kind: "gitlab", id: "gl", origin: "https://gitlab.com"}, {kind: "github", id: "ghe", origin: "https://github.example.org"},
  {kind: "github", id: "gh", origin: "https://api.github.com"}, {kind: "github", id: "gh2", origin: "https://github.com"}] as const;

test("a github.com pull request link opens in the first github.com account", () => {
  assert.deepEqual(linkTarget("https://github.com/o/r/pull/12", accounts), {accountId: "gh", repo: "o/r", number: 12});
  assert.deepEqual(linkTarget("https://github.com/o/r/pull/12/", [accounts[3]]), {accountId: "gh2", repo: "o/r", number: 12});
});

test("other links, and a github.com link with no github.com account, are left alone", () => {
  for (const href of ["https://github.com/o/r/pull/12/files", "https://github.com/o/r/pull/12#discussion_r1", "https://github.com/o/r/issues/12",
    "http://github.com/o/r/pull/12", "https://gitlab.com/o/r/-/merge_requests/3", "not a url"]) assert.equal(linkTarget(href, accounts), null, href);
  assert.equal(linkTarget("https://github.com/o/r/pull/12", accounts.slice(0, 2)), null);
});
