import { expect, test } from "vitest";
import { tempNameFor, TransferHash } from "./reconcile.ts";

test.each([
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
])("hashes the SHA-256 test vector %j with split input", (input, expected) => {
  const hash = new TransferHash();
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i += 7) hash.update(bytes.subarray(i, i + 7));
  expect(hash.finish()).toBe(expected);
});

test("derives an exclusive temporary name from the job and item", () => {
  expect(tempNameFor("223e4567-e89b-42d3-a456-426614174000", 12)).toEqual({
    t: ".commander-223e4567-e89b-42d3-a456-426614174000-12.part",
  });
});
