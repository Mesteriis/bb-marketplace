import test from "node:test";
import assert from "node:assert/strict";
import { answerNote } from "../src/core/pulls/prompt.ts";

test("the answer note names each thread's Makosh Git id and place, and says the answer is a draft", () => {
  const note = answerNote([{id: "0123456789ab", path: "a.ts", line: 5}, {id: "ba9876543210", path: "b.ts", line: null}]);
  assert.match(note, /kept as a draft that the owner posts/);
  assert.match(note, /- `0123456789ab` a\.ts:5\n- `ba9876543210` b\.ts$/);
  assert.equal(answerNote([]), "");
});
