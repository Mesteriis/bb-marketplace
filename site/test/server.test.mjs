// The entry point: what it refuses to start with.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../server.mjs", import.meta.url));
const KEYS = { MAKOSH_TRACK_KEY: "track-key-for-tests-0123456789abcdef", MAKOSH_API_KEY: "feed-key-for-tests-0123456789abcdefg" };

/** Runs the entry point until it exits or says it listens (then it is stopped). */
function start(env) {
  const folder = mkdtempSync(join(tmpdir(), "makosh-site-"));
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, PORT: "0", MAKOSH_DATA_FILE: join(folder, "opens.jsonl"), ...KEYS, ...env } });
  let out = "";
  let err = "";
  let listening = false;
  child.stdout.on("data", (chunk) => {
    out += chunk;
    if (out.includes("listening")) {
      listening = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => (err += chunk));
  return new Promise((resolve) =>
    child.on("close", (code) => {
      rmSync(folder, { recursive: true, force: true });
      resolve({ code, err, listening });
    }),
  );
}

test("without the site's own address it does not start", async () => {
  const { code, err, listening } = await start({});
  assert.equal(listening, false);
  assert.equal(code, 1);
  assert.equal(err.trim(), "MAKOSH_ORIGIN must be set to the site's https address, for example https://makosh.example.org");
});

test("an address that is not a plain https origin is refused", async () => {
  for (const origin of ["http://makosh.example.org", "https://makosh.example.org/path", "makosh.example.org"]) {
    const { code, listening } = await start({ MAKOSH_ORIGIN: origin });
    assert.equal(listening, false, origin);
    assert.equal(code, 1, origin);
  }
});

test("with an https origin it listens", async () => {
  const { listening, err } = await start({ MAKOSH_ORIGIN: "https://makosh.example.org" });
  assert.equal(err, "");
  assert.equal(listening, true);
});
