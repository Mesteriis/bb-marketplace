import test from "node:test";
import assert from "node:assert/strict";
import { en, ru } from "../src/core/i18n/dictionary.ts";
import { format, resolveLanguage } from "../src/core/i18n/language.ts";

test("Russian counts take the form the number asks for", () => {
  assert.equal(format("ru", "count.files", {n: 1}), "1 файл");
  assert.equal(format("ru", "count.files", {n: 3}), "3 файла");
  assert.equal(format("ru", "count.files", {n: 5}), "5 файлов");
  assert.equal(format("ru", "count.files", {n: 11}), "11 файлов");
  assert.equal(format("ru", "count.files", {n: 14}), "14 файлов");
  assert.equal(format("ru", "count.files", {n: 21}), "21 файл");
  assert.equal(format("ru", "count.files", {n: 22}), "22 файла");
  assert.equal(format("ru", "count.files", {n: 0}), "0 файлов");
  assert.equal(format("en", "count.files", {n: 1}), "1 file");
  assert.equal(format("en", "count.files", {n: 2}), "2 files");
  assert.equal(format("en", "count.files", {n: 0}), "0 files");
});

test("values go in by name; a missing value stays visible instead of vanishing", () => {
  assert.equal(format("en", "shell.hiddenProjects", {n: 2}), "Hidden projects (2)");
  assert.equal(format("ru", "shell.hiddenProjects", {n: 2}), "Скрытые проекты (2)");
  assert.equal(format("en", "shell.hiddenProjects"), "Hidden projects ({n})");
});

test("“As in BB” follows BB's language, and an explicit choice wins", () => {
  assert.equal(resolveLanguage("auto", "ru-RU"), "ru");
  assert.equal(resolveLanguage("auto", "ru"), "ru");
  assert.equal(resolveLanguage("auto", "en-US"), "en");
  assert.equal(resolveLanguage("auto", "de"), "en");
  assert.equal(resolveLanguage("auto", undefined), "en");
  assert.equal(resolveLanguage("en", "ru-RU"), "en");
  assert.equal(resolveLanguage("ru", "en-US"), "ru");
  assert.equal(resolveLanguage("nonsense", "ru-RU"), "ru");
});

test("both languages have every string, none empty", () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  for (const [key, value] of [...Object.entries(en), ...Object.entries(ru)]) assert.ok(value.trim(), key);
  // A placeholder in one language is there in the other too.
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const names = (text: string) => [...text.matchAll(/\{(\w+)/g)].map(match => match[1]).sort();
    assert.deepEqual(names(ru[key]), names(en[key]), key);
  }
});
