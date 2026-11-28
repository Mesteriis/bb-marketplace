import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { builtinTemplates } from "../src/core/ci-templates/builtin.ts";
import { renderTemplate, resolveValues } from "../src/core/ci-templates/render.ts";

const golden = new URL("./fixtures/ci-golden/", import.meta.url);
/** The values a fixture was rendered with, from its name: <template>.<param>-<value>….yml (an app folder by its stack). */
function valuesOf(name: string) {
  const [id, ...pairs] = name.replace(/\.yml$/, "").split(".");
  const values: Record<string, string | boolean> = {branch: "main"};
  for (const pair of pairs) {
    const [key, raw] = pair.split(/-(.*)/s) as [string, string];
    values[key] = raw === "true" ? true : raw === "false" ? false : raw;
  }
  if (values.inApp === true) values.appDir = id!.startsWith("go-") ? "src/service" : "src/backend";
  return {id: id!, values};
}

test("Go CI with and without its web UI, and Python CI without one, render byte for byte as in 0.16.1, with the read-only token of 0.16.3 on Actions", () => {
  const names = readdirSync(golden).filter(name => name.endsWith(".yml")).sort();
  assert.equal(names.length, 32);
  for (const name of names) {
    const {id, values} = valuesOf(name);
    const template = builtinTemplates.find(item => item.id === id)!;
    assert.equal(renderTemplate(template, resolveValues(template, {}, values)).text, readFileSync(new URL(name, golden), "utf8"), name);
  }
});

test("Python CI with a web UI sets up Node.js and checks it as Go does: in the same job on Actions and Azure, its own job on GitLab", () => {
  const render = (id: string, values: Record<string, string | boolean>) => {
    const template = builtinTemplates.find(item => item.id === id)!;
    return renderTemplate(template, resolveValues(template, {}, {branch: "main", pythonTool: "uv", lockfile: false, test: true, ...values})).text;
  };
  const actions = render("python-github", {web: true, make: true, inApp: true, appDir: "src/backend"});
  assert.match(actions, /- uses: actions\/setup-python@v5\n {8}with:\n {10}python-version: "3\.12"\n {6}- uses: actions\/setup-node@v4\n {8}with:\n {10}node-version: "24"\n/);
  assert.match(actions, /- name: Install\n {8}run: pip install uv==0\.13\.10 && uv sync\n {8}working-directory: src\/backend\n {6}- name: Check\n {8}run: make check\n$/);
  // Without make check the web UI is its own step after the stack's, at the root.
  assert.match(render("python-github", {web: true, make: false}), /\n {6}- name: Web\n {8}run: make web-check\n$/);
  const lab = render("python-gitlab", {web: true, make: true});
  assert.match(lab, /^ {4}- make check WEB=0$/m);
  assert.match(lab, /\nweb:\n {2}image: node:24\n {2}script:\n {4}- make web-check\n$/);
  assert.match(render("python-azure", {web: true, make: true}), /- task: UsePythonVersion@0\n {4}inputs:\n {6}versionSpec: "3\.12"\n {2}- task: NodeTool@0\n {4}inputs:\n {6}versionSpec: "24\.x"\n/);
  assert.equal(render("python-github", {web: false, make: true}).includes("setup-node"), false);
});
