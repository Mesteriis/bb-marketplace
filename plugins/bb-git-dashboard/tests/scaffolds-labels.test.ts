import assert from "node:assert/strict";
import { test } from "node:test";
import { en, ru } from "../src/core/i18n/dictionary.ts";
import { scaffoldLabelKey } from "../src/core/scaffolds/labels.ts";
import { builtinScaffolds } from "../src/templates/scaffolds/index.ts";

test("a scaffold parameter's label is looked up by the scaffold and the parameter", () => {
  assert.equal(scaffoldLabelKey("python-service-uv", "package"), "sc.python-service-uv.package");
  assert.equal(scaffoldLabelKey("a-scaffold-of-the-owner", "flavour"), null);
});

test("every built-in scaffold parameter has a label in English and Russian", () => {
  const missing: string[] = [];
  for (const scaffold of builtinScaffolds) for (const param of scaffold.params) {
    const key = scaffoldLabelKey(scaffold.id, param.name);
    if (!key || !en[key] || !ru[key]) missing.push(scaffold.id + "." + param.name);
  }
  assert.deepEqual(missing, []);
  assert.equal(en["sc.python-service-uv.package"], "Python package (import name)");
  assert.equal(ru["sc.python-service-uv.package"], "Пакет Python (имя для импорта)");
});
