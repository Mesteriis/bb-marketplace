// Ported from plugins/bb-github-pr-dashboard/prs.test.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
import assert from "node:assert/strict";
import { test } from "node:test";
import { jiraHref, jiraLinker, jiraPrefixes, jiraSite, linkJira, splitJira } from "../src/core/pulls/jira.ts";

test("jira: prefixes come from bracketed keys, branches and Jira URLs only", () => {
  assert.deepEqual([...jiraPrefixes("[ABC-12] Fix UTF-8 parsing", "feature/ABC-12/parse", "uses SHA-256")], ["ABC"]);
  assert.deepEqual([...jiraPrefixes("Fix UTF-8 parsing", "main", "uses SHA-256")], []);
  assert.equal(jiraSite("see https://acme.atlassian.net/browse/ABC-1 now"), "https://acme.atlassian.net");
  assert.equal(jiraHref("ABC-1", { plugin: true, siteUrl: null }), "/plugins/my-jira/tickets/ABC-1");
  assert.equal(jiraHref("ABC-1", { plugin: false, siteUrl: "https://acme.atlassian.net/" }), "https://acme.atlassian.net/browse/ABC-1");
  assert.equal(jiraHref("ABC-1", { plugin: false, siteUrl: null }), null);
});

test("jira: keys linked in prose, not in code or existing links; URLs go to My Jira when it runs", () => {
  const href = (k: string) => `/plugins/my-jira/tickets/${k}`;
  const md = "Fixes ABC-7 and UTF-8.\n`ABC-8` stays\n```\nABC-9\n```\n[ABC-10](https://acme.atlassian.net/browse/ABC-10) and https://acme.atlassian.net/browse/ABC-11 plus https://x.io/ABC-12";
  assert.equal(
    linkJira(md, new Set(["ABC"]), href, true),
    "Fixes [ABC-7](/plugins/my-jira/tickets/ABC-7) and UTF-8.\n`ABC-8` stays\n```\nABC-9\n```\n[ABC-10](/plugins/my-jira/tickets/ABC-10) and [ABC-11](/plugins/my-jira/tickets/ABC-11) plus https://x.io/ABC-12",
  );
  assert.equal(linkJira("ABC-7 https://acme.atlassian.net/browse/ABC-1", new Set(["ABC"]), (k) => `https://acme.atlassian.net/browse/${k}`, false),
    "[ABC-7](https://acme.atlassian.net/browse/ABC-7) https://acme.atlassian.net/browse/ABC-1");
});

test("jira: a title splits into text and keys of the named projects", () => {
  assert.deepEqual(splitJira("[ABC-12] Fix ABC-3 and UTF-8", new Set(["ABC"])), ["[", "ABC-12", "] Fix ", "ABC-3", " and UTF-8"]);
  assert.deepEqual(splitJira("[ABC-12] Fix", new Set()), ["[ABC-12] Fix"]);
});

test("jira: a pull request's keys open on the site its description links to when My Jira is not running", () => {
  const pr = {title: "[ABC-12] Fix", headRefName: "main", body: "See https://acme.atlassian.net/browse/ABC-1"};
  const offline = jiraLinker(pr, {plugin: false, siteUrl: null});
  assert.deepEqual([[...offline.prefixes], offline.href("ABC-12"), offline.plugin], [["ABC"], "https://acme.atlassian.net/browse/ABC-12", false]);
  assert.equal(jiraLinker(pr, {plugin: true, siteUrl: "https://x.atlassian.net"}).href("ABC-12"), "/plugins/my-jira/tickets/ABC-12");
  assert.equal(jiraLinker({...pr, body: ""}, {plugin: false, siteUrl: null}).href("ABC-12"), null);
});

test("jira: keys inside ~~~ fences stay as they are", () => {
  assert.equal(linkJira("~~~\nABC-1\n~~~ and ABC-2", new Set(["ABC"]), (k) => "/j/" + k, false), "~~~\nABC-1\n~~~ and [ABC-2](/j/ABC-2)");
});
