import test from "node:test";
import assert from "node:assert/strict";
import { homeRelative } from "../src/core/short-path.ts";

test("a path under a home folder is shown from ~; others as they are", () => {
  assert.equal(homeRelative("/Users/owner/projects/Work/web"), "~/projects/Work/web");
  assert.equal(homeRelative("/home/owner/src/api"), "~/src/api");
  assert.equal(homeRelative("/Users/owner"), "~");
  assert.equal(homeRelative("/srv/git/web"), "/srv/git/web");
  assert.equal(homeRelative("/Users/Shared/web"), "/Users/Shared/web");
});
