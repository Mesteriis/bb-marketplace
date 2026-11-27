// Ported from plugins/git-history/graph.test.ts (MIT, © 2026 Yusuf Akbulut); vitest replaced by node:test.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CommitSummary } from "../src/core/history/model.ts";
import { layoutCommitGraph } from "../src/core/history/graph.ts";

function commit(hash: string, parents: string[]): CommitSummary {
  return {
    hash,
    parents,
    authorName: "Test",
    authorEmail: "test@example.com",
    authorDate: "2026-01-01T00:00:00Z",
    committerDate: "2026-01-01T00:00:00Z",
    subject: hash,
    refs: [],
  };
}

describe("layoutCommitGraph", () => {
  it("keeps a linear history in one lane", () => {
    const rows = layoutCommitGraph([
      commit("c", ["b"]),
      commit("b", ["a"]),
      commit("a", []),
    ]);

    assert.deepEqual(rows.map((row) => row.commitLane), [0, 0, 0]);
    assert.deepEqual(rows[0]?.edges, [
      { fromLane: 0, toLane: 0, kind: "straight" },
    ]);
  });

  it("opens and rejoins a merge lane", () => {
    const rows = layoutCommitGraph([
      commit("merge", ["main", "feature"]),
      commit("feature", ["base"]),
      commit("main", ["base"]),
      commit("base", []),
    ]);

    assert.deepEqual(rows[0]?.edges, [
      { fromLane: 0, toLane: 0, kind: "straight" },
      { fromLane: 0, toLane: 1, kind: "merge" },
    ]);
    assert.equal(rows[1]?.commitLane, 1);
    assert.equal(rows[2]?.commitLane, 0);
  });

  it("allocates independent tips without overwriting active lanes", () => {
    const rows = layoutCommitGraph([
      commit("tip-a", ["root-a"]),
      commit("tip-b", ["root-b"]),
      commit("root-a", []),
      commit("root-b", []),
    ]);

    assert.equal(rows[0]?.commitLane, 0);
    assert.equal(rows[1]?.commitLane, 1);
  });
});
