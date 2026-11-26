// The slug formula exists twice on purpose: `serverSlug` here and in scripts/server-slug.mjs (the manifest
// checker must not import TypeScript). Both are pinned to the same literal outputs, so drift fails CI.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { serverSlug } from "../src/core/collection";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/server-slug.mjs");

const TABLE: [name: string, slug: string][] = [
  ["io.github.Acme/Time-Server", "io-github-acme-time-server"],
  ["io.example/Demo", "io-example-demo"],
  ["Foo__Bar", "foo-bar"],
  ["--a--", "a"],
  ["A/B/C", "a-b-c"],
  ["x..y", "x-y"],
  ["/leading", "leading"],
  ["trailing/", "trailing"],
  ["UPPER_lower.9", "upper-lower-9"],
  ["123", "123"],
  ["a   b", "a-b"],
  ["ä/ö", ""],
  ["", ""],
];

describe("serverSlug formula", () => {
  it.each(TABLE)("the plugin maps %j to %j", (name, slug) => {
    expect(serverSlug(name)).toBe(slug);
  });

  it.each(TABLE)("the manifest checker maps %j to %j", async (name, slug) => {
    const checker = (await import(/* @vite-ignore */ pathToFileURL(script).href)) as { serverSlug: (name: string) => string };
    expect(checker.serverSlug(name)).toBe(slug);
  });
});
