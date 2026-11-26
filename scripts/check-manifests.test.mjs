import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-manifests.mjs");

/** Runs the checker on a throw-away tree that holds only an mcp-collection; the plugin problems it also prints are ignored. */
function checkCollection(files) {
  const root = mkdtempSync(join(tmpdir(), "check-manifests-"));
  writeFileSync(join(root, "subtrees.json"), JSON.stringify({ plugins: [] }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  return run.stderr;
}

test("a non-object index entry gets one short message with its position", () => {
  const out = checkCollection({ "mcp-collection/index.json": JSON.stringify({ servers: [null, "x", ["y"]] }) });
  for (const position of [1, 2, 3]) {
    assert.match(out, new RegExp(`mcp-collection/index.json \\(entry #${position}\\): must be an object with string name, version and path`));
  }
});

test("an entry with a non-string field says which fields", () => {
  const out = checkCollection({ "mcp-collection/index.json": JSON.stringify({ servers: [{ name: "a/b", version: 1, path: "p" }] }) });
  assert.match(out, /mcp-collection\/index.json \(a\/b\): name, version and path must all be strings/);
});

test("a non-object entry.json is one clear problem, not a list of missing fields", () => {
  const out = checkCollection({
    "mcp-collection/index.json": JSON.stringify({ servers: [{ name: "a/b", version: "1.0.0", path: "mcp-collection/a-b" }] }),
    "mcp-collection/a-b/server.json": "{}",
    "mcp-collection/a-b/review.md": "ok",
    "mcp-collection/a-b/entry.json": "[]",
  });
  assert.match(out, /mcp-collection\/index.json \(a\/b\): entry.json must be a JSON object/);
  assert.doesNotMatch(out, /entry.json: name must be a string/);
});

/** A one-server collection whose server.json has the given package and whose entry.json carries `docker`. */
function dockerCollection(registryType, docker, environmentVariables) {
  const server = JSON.stringify({ name: "a/b", version: "1.0.0", packages: [{ registryType, ...(environmentVariables === undefined ? {} : { environmentVariables }) }] });
  const entry = { name: "a/b", version: "1.0.0", serverJsonSha256: createHash("sha256").update(server).digest("hex"), choice: { kind: "package", index: 0 }, acceptedAt: "2026-11-26T00:00:00Z", docker };
  return {
    "mcp-collection/index.json": JSON.stringify({ servers: [{ name: "a/b", version: "1.0.0", path: "mcp-collection/a-b" }] }),
    "mcp-collection/a-b/server.json": server,
    "mcp-collection/a-b/review.md": "ok",
    "mcp-collection/a-b/entry.json": JSON.stringify(entry),
  };
}

test("docker in entry.json: valid for an OCI package, an invalid value or a non-OCI package is a problem", () => {
  assert.doesNotMatch(checkCollection(dockerCollection("oci", { network: "bridge", user: "image" })), /mcp-collection\/index.json \(a\/b\)/);
  assert.match(checkCollection(dockerCollection("oci", { network: "host" })), /\(a\/b\): entry.json: docker.network must be one of none, bridge/);
  assert.match(checkCollection(dockerCollection("oci", { user: "root" })), /\(a\/b\): entry.json: docker.user must be one of nobody, image/);
  assert.match(checkCollection(dockerCollection("oci", { extra: 1 })), /\(a\/b\): entry.json: docker must be an object with only network and user/);
  assert.match(checkCollection(dockerCollection("npm", { network: "bridge" })), /\(a\/b\): entry.json: поле docker допустимо только для образа OCI/);
});

test("the real mcp-collection passes the checker", () => {
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /collection server\(s\)/);
});

test("docker key check ignores inherited object keys", () => {
  assert.match(checkCollection(dockerCollection("oci", { constructor: 1 })), /\(a\/b\): entry.json: docker must be an object with only network and user/);
});

test("an OCI package may not declare variables that change the docker command", () => {
  for (const name of ["DOCKER_HOST", "HOME", "DYLD_INSERT_LIBRARIES", "PATH", "LD_PRELOAD", "PYTHONPATH"]) {
    assert.match(
      checkCollection(dockerCollection("oci", undefined, [{ name }])),
      new RegExp(`\\(a/b\\): server.json: переменная «${name}» запрещена для образа OCI: она меняет запуск docker`),
    );
  }
  assert.doesNotMatch(checkCollection(dockerCollection("oci", undefined, [{ name: "API_KEY" }])), /запрещена/);
  assert.doesNotMatch(checkCollection(dockerCollection("npm", undefined, [{ name: "HOME" }])), /запрещена/);
});
