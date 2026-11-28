import { afterEach, expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { createTransferHash, setSha256Factory, TransferHash } from "../../core/reconcile.ts";
import { installNativeSha256 } from "./native-sha256.ts";

afterEach(() => setSha256Factory(null));

test("the core hash is the portable one until the adapter installs the native one", () => {
  expect(createTransferHash()).toBeInstanceOf(TransferHash);
  installNativeSha256();
  expect(createTransferHash()).not.toBeInstanceOf(TransferHash);
});

test.each([
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
])("the native hash matches the SHA-256 vector %j with split input", (input, expected) => {
  installNativeSha256();
  const hash = createTransferHash();
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i += 5) hash.update(bytes.subarray(i, i + 5));
  expect(hash.finish()).toBe(expected);
});

test("the native hash agrees with the portable one on random data across block boundaries", () => {
  const data = randomBytes(300_001);
  const portable = new TransferHash();
  installNativeSha256();
  const native = createTransferHash();
  for (let i = 0; i < data.length; i += 4097) {
    portable.update(data.subarray(i, i + 4097));
    native.update(data.subarray(i, i + 4097));
  }
  expect(native.finish()).toBe(portable.finish());
});
