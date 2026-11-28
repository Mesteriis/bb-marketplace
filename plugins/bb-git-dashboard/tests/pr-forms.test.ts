import test from "node:test";
import assert from "node:assert/strict";
import { afterWrite, emptyForms } from "../src/ui/review/pr-forms.ts";

test("a write starts again only the form that made it; the rest keeps what was typed", () => {
  const typed = {...emptyForms, comment: "Thanks", description: "New text", reviewer: "bob", summary: "Looks good", event: "APPROVE" as const, threads: "all" as const};
  assert.deepEqual(afterWrite(typed, "resolve"), typed);
  assert.deepEqual(afterWrite(typed, "comment"), {...typed, comment: ""});
  assert.deepEqual(afterWrite(typed, "review"), {...typed, summary: "", event: "COMMENT"});
  assert.deepEqual(afterWrite(typed, "editBody"), {...typed, description: null});
  assert.deepEqual(afterWrite(typed, "requestReviewer"), {...typed, reviewer: ""});
});
