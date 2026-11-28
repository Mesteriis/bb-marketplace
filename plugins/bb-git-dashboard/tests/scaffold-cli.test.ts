import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const cli = new URL("../scripts/scaffold.ts", import.meta.url).pathname;
const fixture = new URL("./fixtures/scaffold-repo", import.meta.url).pathname;
const run = (...args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {encoding: "utf8"});
let out: string;
beforeEach(() => { out = realpathSync(mkdtempSync(join(tmpdir(), "scaffold-cli-"))); });
afterEach(() => rmSync(out, {recursive: true, force: true}));

test("list names the templates offered and those refused, and fails when one is refused", () => {
  const listed = run("list", fixture);
  assert.equal(listed.status, 1);
  assert.equal(listed.stdout, "demo\tDemo service\n");
  assert.equal(listed.stderr, "refused broken: templates/broken/template.json does not match the template format: unknown field surprise.\n");
});

test("variants gives each choice and flag from the defaults, one JSON object a line", () => {
  const lines = run("variants", fixture, "demo").stdout.trim().split("\n").map(line => JSON.parse(line));
  // The defaults, three licenses, two common flags, two kinds and Docker.
  assert.equal(lines.length, 9);
  assert.deepEqual([lines[0].variant, lines[0].docker, lines[0].license], ["plain", false, "MIT"]);
});

test("render writes the project with its bytes, executable bits and CI file; a value that does not fit is refused", () => {
  const target = join(out, "shop");
  const made = run("render", fixture, "demo", "--out", target, "--set", "name=shop", "--set", "docker=true", "--set", "variant=web", "--forge", "github");
  assert.equal(made.status, 0, made.stderr);
  assert.equal(readFileSync(join(target, "src/service/shop.py"), "utf8"), "print(\"shop\")\n");
  assert.deepEqual([...readFileSync(join(target, "src/service/icon.png"))], [0x89, 0x50, 0x4e, 0x47, 0, 1]);
  assert.equal(statSync(join(target, "run.sh")).mode & 0o111, 0o111);
  assert.ok(existsSync(join(target, "docker/Dockerfile")) && existsSync(join(target, "LICENSE")));
  const refused = run("render", fixture, "demo", "--out", join(out, "bad"), "--set", "variant=desktop");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /TEMPLATE_INVALID: value of variant does not fit the parameter/);
  assert.ok(!existsSync(join(out, "bad")));
  assert.equal(run("render", fixture, "demo", "--out", target).status, 1, "an existing folder is not written into");
});
