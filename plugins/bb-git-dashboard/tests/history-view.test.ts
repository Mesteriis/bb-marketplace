import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CommitSummary, Ref } from "../src/core/history/model.ts";
import { conventionalPrefix, dayGroups, matchesCommit, patchStats, visibleRefs } from "../src/core/history/view.ts";

const ref = (name: string, kind: Ref["kind"] = "local", isHead = false): Ref =>
  ({name, fullName: (kind === "tag" ? "refs/tags/" : kind === "remote" ? "refs/remotes/" : "refs/heads/") + name, kind, isHead});
function commit(hash: string, authorDate: string, extra: Partial<CommitSummary> = {}): CommitSummary {
  return {hash, parents: [], authorName: "Ada Lovelace", authorEmail: "ada@example.com", authorDate, committerDate: authorDate,
    subject: "feat(ui): add the search box", refs: [], ...extra};
}

describe("matchesCommit", () => {
  const sample = commit("a1b2c3d4e5f6", "2026-11-27T10:00:00Z", {refs: [ref("release/1.2", "tag")]});
  it("finds by subject, hash prefix, author, e-mail and ref, ignoring case", () => {
    assert.equal(matchesCommit(sample, "SEARCH"), true);
    assert.equal(matchesCommit(sample, "a1b2c3"), true);
    assert.equal(matchesCommit(sample, "lovelace"), true);
    assert.equal(matchesCommit(sample, "ada@example"), true);
    assert.equal(matchesCommit(sample, "release/1.2"), true);
  });
  it("needs every word to match somewhere", () => {
    assert.equal(matchesCommit(sample, "ada box"), true);
    assert.equal(matchesCommit(sample, "ada missing"), false);
  });
  it("matches a hash only from its start", () => {
    assert.equal(matchesCommit(sample, "c3d4"), false);
  });
  it("treats an empty query as no filter", () => {
    assert.equal(matchesCommit(sample, "   "), true);
  });
  it("reads regular-expression characters literally", () => {
    assert.equal(matchesCommit(sample, "(ui)"), true);
    assert.equal(matchesCommit(sample, ".*"), false);
  });
});

describe("dayGroups", () => {
  // 2026-11-27 is a Friday.
  const now = Date.parse("2026-11-27T15:00:00Z");
  it("labels today, yesterday, weekdays of the last week and older dates", () => {
    const groups = dayGroups([
      commit("a", "2026-11-27T09:00:00Z"), commit("b", "2026-11-27T01:00:00Z"),
      commit("c", "2026-11-26T22:00:00Z"), commit("d", "2026-11-23T12:00:00Z"), commit("e", "2026-11-19T12:00:00Z"),
    ], now, 0);
    assert.deepEqual(groups.map(group => [group.label, group.start, group.count]), [
      ["Today", 0, 2], ["Yesterday", 2, 1], ["Monday", 3, 1], ["2026-11-19", 4, 1],
    ]);
  });
  it("uses the viewer's time zone for the day boundary", () => {
    // 23:30 UTC on the 26th is already the 27th at UTC+3.
    const groups = dayGroups([commit("a", "2026-11-26T23:30:00Z")], now, 180);
    assert.deepEqual(groups.map(group => group.label), ["Today"]);
  });
  it("starts a new group when the day comes back after a gap in order", () => {
    const groups = dayGroups([commit("a", "2026-11-27T09:00:00Z"), commit("b", "2026-11-25T09:00:00Z"), commit("c", "2026-11-27T08:00:00Z")], now, 0);
    assert.deepEqual(groups.map(group => [group.label, group.count]), [["Today", 1], ["Wednesday", 1], ["Today", 1]]);
  });
});

describe("conventionalPrefix", () => {
  it("splits a conventional type, scope and breaking mark from the rest", () => {
    assert.deepEqual(conventionalPrefix("feat(ui): add the search box"), {prefix: "feat(ui):", rest: " add the search box"});
    assert.deepEqual(conventionalPrefix("fix!: drop the old flag"), {prefix: "fix!:", rest: " drop the old flag"});
  });
  it("leaves an ordinary subject alone", () => {
    assert.equal(conventionalPrefix("Merge branch 'main'"), null);
    assert.equal(conventionalPrefix("note:x without a space"), null);
    assert.equal(conventionalPrefix("Feat: capitalised is not a type"), null);
  });
});

describe("visibleRefs", () => {
  it("shows the head first and folds the rest after the limit", () => {
    const refs = [ref("origin/main", "remote"), ref("v1", "tag"), ref("main", "local", true), ref("dev"), ref("next")];
    const {shown, hidden} = visibleRefs(refs, 3);
    assert.deepEqual(shown.map(item => item.name), ["main", "origin/main", "v1"]);
    assert.deepEqual(hidden.map(item => item.name), ["dev", "next"]);
  });
  it("hides nothing when the refs fit", () => {
    assert.deepEqual(visibleRefs([ref("main")], 3).hidden, []);
  });
});

describe("patchStats", () => {
  it("counts added and removed lines but not the file headers", () => {
    const text = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " same", "-old", "+new", "+more", ""].join("\n");
    assert.deepEqual(patchStats(text), {added: 2, removed: 1});
  });
  it("counts nothing for an empty patch", () => {
    assert.deepEqual(patchStats(""), {added: 0, removed: 0});
  });
});

describe("dayGroups across a daylight-saving change", () => {
  it("places each commit by its own offset", () => {
    // Summer +180, winter +120: 22:30Z on Nov 26 is 00:30 on the 27th locally, 22:30Z on Jul 1 is 01:30 on Jul 2.
    const offsetAt = (time: number) => new Date(time).getUTCMonth() === 6 ? 180 : 120;
    const groups = dayGroups([commit("a", "2026-11-26T22:30:00Z"), commit("b", "2026-07-01T22:30:00Z")], Date.parse("2026-11-27T10:00:00Z"), offsetAt);
    assert.deepEqual(groups.map(group => group.label), ["Today", "2026-07-02"]);
  });
});
