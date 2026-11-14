#!/usr/bin/env node
// Resolves a release tag to the plugin it releases and checks that the tag
// version equals that plugin's package.json version.
//
//   node scripts/release-info.mjs <plugin>/v<X.Y.Z>
//
// Prints `plugin=`, `directory=`, and `version=` lines (the release workflow
// appends them to $GITHUB_OUTPUT). Exits 1 with a reason when the tag does
// not name a releasable state.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`release-info: ${message}`);
  process.exit(1);
}

const tag = process.argv[2] ?? "";
const match = /^([a-z0-9][a-z0-9-]*)\/v(\d+\.\d+\.\d+)$/.exec(tag);
if (match === null) {
  fail(`"${tag}" is not a release tag; expected <plugin>/vX.Y.Z, such as mail/v0.1.0`);
}
const [, name, version] = match;

const collection = JSON.parse(readFileSync(join(root, ".bb/plugins.json"), "utf8"));
const entry = collection.plugins.find((plugin) => plugin.name === name);
if (entry === undefined) {
  const known = collection.plugins.map((plugin) => plugin.name).join(", ");
  fail(`no plugin named "${name}" in .bb/plugins.json (known: ${known})`);
}

const directory = entry.source.replace(/^\.\//, "");
const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
if (manifest.version !== version) {
  fail(`tag says ${version}, but ${directory}/package.json says ${manifest.version}`);
}

console.log(`plugin=${name}`);
console.log(`directory=${directory}`);
console.log(`version=${version}`);
