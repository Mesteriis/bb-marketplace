// The vitest matchers the tests ported from diff-review use, over node:assert.
import assert from "node:assert/strict";
export { describe, it, afterEach } from "node:test";

const contains = (actual: unknown, part: unknown) =>
  typeof actual === "string" ? actual.includes(String(part)) : Array.isArray(actual) && actual.includes(part);

const matches = (error: Error, pattern?: RegExp | string) =>
  pattern === undefined || (typeof pattern === "string" ? error.message.includes(pattern) : pattern.test(error.message));

export function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toMatch: (pattern: RegExp) => assert.match(String(actual), pattern),
    toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
    toBeNull: () => assert.strictEqual(actual, null),
    toContain: (part: unknown) => assert.ok(contains(actual, part), `expected ${JSON.stringify(actual)?.slice(0, 200)} to contain ${JSON.stringify(part)}`),
    not: {
      toBe: (expected: unknown) => assert.notStrictEqual(actual, expected),
      toContain: (part: unknown) => assert.ok(!contains(actual, part), `expected not to contain ${JSON.stringify(part)}`),
    },
    rejects: {
      toThrow: (pattern?: RegExp | string) => assert.rejects(actual as Promise<unknown>, (error: Error) => matches(error, pattern)),
    },
    toThrow: (pattern?: RegExp | string) => assert.throws(actual as () => unknown, (error: Error) => matches(error, pattern)),
  };
}
