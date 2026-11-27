import assert from "node:assert/strict";
import { test } from "node:test";
import { renderText, resolveParams, secretIssues, templateParam, type TemplateParam } from "../src/core/templating/engine.ts";

const params: TemplateParam[] = [
  {name: "name", label: "Name", kind: "text", default: "app"},
  {name: "description", label: "Description", kind: "line", default: ""},
  {name: "docker", label: "Docker", kind: "flag", default: false},
];

test("a line value is one line of free text: spaces, quotes and Unicode, no control characters or template braces", () => {
  assert.deepEqual(resolveParams(params, {description: "Сервис \"для\" заметок: v2 — beta"}, {}),
    {name: "app", description: "Сервис \"для\" заметок: v2 — beta", docker: false});
  assert.equal(resolveParams(params, {description: ""}, {}).description, "");
  for (const bad of ["two\nlines", "tab\there", "x".repeat(201), "a {{name}}", "b }} c"])
    assert.throws(() => resolveParams(params, {description: bad}, {}), /TEMPLATE_INVALID/, JSON.stringify(bad));
});

test("in raw text a line value goes as it is; elsewhere only through |json, which quotes and escapes it", () => {
  const values = {name: "app", description: "Say \"hi\" \\ bye", docker: true};
  assert.equal(renderText("# {{name}}\n\n{{description}}\n", params, values, {raw: true}), "# app\n\nSay \"hi\" \\ bye\n");
  assert.equal(renderText("description = {{description|json}}\nname = {{name|json}}\n", params, values, {raw: false}),
    "description = \"Say \\\"hi\\\" \\\\ bye\"\nname = \"app\"\n");
  assert.throws(() => renderText("description = {{description}}\n", params, values, {raw: false}), /TEMPLATE_INVALID/);
  assert.throws(() => renderText("{{docker|json}}\n", params, values, {raw: true}), /TEMPLATE_INVALID/);
  assert.throws(() => renderText("{{name|yaml}}\n", params, values, {raw: true}), /TEMPLATE_INVALID/);
});

test("sections work as in CI templates and every line is checked whether kept or not", () => {
  const values = {name: "app", description: "", docker: false};
  assert.equal(renderText("a\n{{#docker}}\nDockerfile {{name}}\n{{/docker}}\nb\n", params, values, {raw: true}), "a\nb\n");
  assert.throws(() => renderText("{{#docker}}\n{{nope}}\n{{/docker}}\n", params, values, {raw: true}), /TEMPLATE_INVALID/);
});

test("a text parameter may narrow its values with a pattern; a default that breaks it is the template's fault", () => {
  const pkg: TemplateParam[] = [{name: "package", label: "Package", kind: "text", default: "app", pattern: "^[a-z_][a-z0-9_]*$"}];
  assert.deepEqual(resolveParams(pkg, {package: "my_app"}, {}), {package: "my_app"});
  assert.throws(() => resolveParams(pkg, {package: "my-app"}, {}), /TEMPLATE_INVALID/);
  // A suggestion that does not fit falls back to the default.
  assert.deepEqual(resolveParams(pkg, {}, {package: "My-App"}), {package: "app"});
  assert.throws(() => resolveParams([{name: "package", label: "Package", kind: "text", default: "Bad-Default", pattern: "^[a-z_][a-z0-9_]*$"}], {}, {}), /TEMPLATE_INVALID/);
});

test("loopback and the any-address are no machine's address; others are", () => {
  assert.deepEqual(secretIssues("host = \"127.0.0.1\"\nbind: 0.0.0.0:8000\n", {addresses: false}), []);
  assert.deepEqual(secretIssues("upstream 192.168.1.20\n", {addresses: false}), ["an IP address"]);
});

test("a pattern with a quantified group inside a quantifier is refused, so a value cannot hang the server", () => {
  for (const pattern of ["^(a+)+$", "^(a|aa)*$", "^([a-z]*)*x$", "(x+){2,}"])
    assert.equal(templateParam.safeParse({name: "p", label: "P", kind: "text", default: "a", pattern}).success, false, pattern);
  assert.equal(templateParam.safeParse({name: "p", label: "P", kind: "text", default: "a", pattern: "^[a-z_][a-z0-9_]*(/[a-z]+)+$"}).success, false);
  assert.equal(templateParam.safeParse({name: "p", label: "P", kind: "text", default: "a", pattern: "^[a-z_][a-z0-9_]{0,59}$"}).success, true);
});
