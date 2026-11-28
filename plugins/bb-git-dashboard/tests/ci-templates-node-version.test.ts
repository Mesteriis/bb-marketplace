import assert from "node:assert/strict";
import { test } from "node:test";
import { ciNode } from "../src/core/ci-templates/node-version.ts";

test("CI runs Node.js 24 whenever the engines range admits it, whatever its lower bound", () => {
  for (const range of [undefined, "", ">=22.12", ">=22.18", ">=24.15", "^22.22.2 || ^24.15.0", ">=18", "24", "24.x", "^24", "~24.11", "*", ">=20 <25", "22 - 24"])
    assert.equal(ciNode(range), "24", String(range));
});

test("a range without 24 gets the newest even (LTS) major it admits, else its lowest major", () => {
  assert.equal(ciNode("^22"), "22");
  assert.equal(ciNode("22.x"), "22");
  assert.equal(ciNode("~22.11.0"), "22");
  assert.equal(ciNode(">=20 <24"), "22");
  assert.equal(ciNode("<=22.9"), "22");
  assert.equal(ciNode("^20 || ^22"), "22");
  assert.equal(ciNode(">=26"), "26");
  assert.equal(ciNode("^23"), "23");
  assert.equal(ciNode(">23.1 <24"), "23");
});

test("a range it cannot read, or one nothing satisfies, gets 24", () => {
  for (const range of ["latest", "lts/*", ">=24 <22", "node", "v"]) assert.equal(ciNode(range), "24", range);
});
