import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReviewFile, writeReviewFile } from "../src/adapters/bb/review-files.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function folder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-files-")));
  return {root, done: () => rmSync(root, {recursive: true, force: true})};
}

test("a file is read with the hash of its bytes; binary, linked, missing and outside paths are refused", async () => {
  const {root, done} = folder();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "one\ntwo\n");
    assert.deepEqual(await readReviewFile(root, "src/a.ts"), {text: "one\ntwo\n", sha256: sha("one\ntwo\n")});
    writeFileSync(join(root, "bin"), Buffer.from([1, 0, 2]));
    await assert.rejects(readReviewFile(root, "bin"), {message: "BINARY_FILE"});
    symlinkSync("/etc/hosts", join(root, "link"));
    await assert.rejects(readReviewFile(root, "link"), {message: "INVALID_PATH"});
    await assert.rejects(readReviewFile(root, "../x"), {message: "INVALID_PATH"});
    await assert.rejects(readReviewFile(root, ".git/config"), {message: "INVALID_PATH"});
    await assert.rejects(readReviewFile(root, "gone.ts"), {message: "NOT_FOUND"});
  } finally { done(); }
});

test("a write lands only over the bytes it was computed from, and keeps the file's mode", async () => {
  const {root, done} = folder();
  try {
    writeFileSync(join(root, "run.sh"), "echo one\n");
    chmodSync(join(root, "run.sh"), 0o755);
    await writeReviewFile(root, "run.sh", sha("echo one\n"), "echo two\n");
    assert.equal(readFileSync(join(root, "run.sh"), "utf8"), "echo two\n");
    assert.equal(statSync(join(root, "run.sh")).mode & 0o777, 0o755);
    await assert.rejects(writeReviewFile(root, "run.sh", sha("echo one\n"), "echo three\n"), {message: "CHANGED"});
    assert.equal(readFileSync(join(root, "run.sh"), "utf8"), "echo two\n");
  } finally { done(); }
});

test("a file that is not UTF-8 is refused, so writing it back cannot replace its bytes", async () => {
  const {root, done} = folder();
  try {
    writeFileSync(join(root, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await assert.rejects(readReviewFile(root, "latin.txt"), {message: "NOT_UTF8"});
  } finally { done(); }
});
