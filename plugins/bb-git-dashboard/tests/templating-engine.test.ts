import assert from "node:assert/strict";
import { test } from "node:test";
import { renderText, resolveParams, type TemplateParam } from "../src/core/templating/engine.ts";

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
