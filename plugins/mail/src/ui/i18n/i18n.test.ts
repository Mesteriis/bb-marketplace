import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { dateLocale, getLanguage, msg, resolveLanguage, setLanguage, t, tn, tx } from "./index.ts";
import { RU, UNTRANSLATED } from "./ru.ts";

afterEach(() => setLanguage("en"));

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, "..", "..", "..");

/** Every literal text the pages pass to tx, txn or msg. */
function pageTexts(): Map<string, string> {
  const files = [
    join(plugin, "app.tsx"),
    ...readdirSync(join(plugin, "src/ui"))
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))
      .map((name) => join(plugin, "src/ui", name)),
  ];
  const texts = new Map<string, string>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fn = node.expression.text;
        if (fn === "tx" || fn === "txn" || fn === "msg") {
          const args = fn === "txn" ? node.arguments.slice(1, 3) : node.arguments.slice(0, 1);
          for (const arg of args) {
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) texts.set(arg.text, file);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return texts;
}

const placeholders = (text: string) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((m) => m[1]!).sort();

describe("t", () => {
  it("returns English as written and fills values as text", () => {
    expect(t("Load more")).toBe("Load more");
    expect(t("Synced {when}", { when: "10:42" })).toBe("Synced 10:42");
    expect(t("Moved to {p1}", { p1: "<b>Archive</b>" })).toBe("Moved to <b>Archive</b>");
    expect(t("Open {missing}")).toBe("Open {missing}");
    expect(tx).toBe(t);
    expect(msg("Undo")).toBe("Undo");
  });

  it("answers in Russian once the page is Russian, and falls back to English for unknown text", () => {
    setLanguage("ru");
    expect(getLanguage()).toBe("ru");
    expect(t("Load more")).toBe(RU["Load more"]);
    expect(t("Load more")).not.toBe("Load more");
    expect(t("Synced {when}", { when: "10:42" })).toMatch(/10:42$/);
    expect(t("Invented text nobody translated")).toBe("Invented text nobody translated");
  });

  it("picks the Russian form by the count", () => {
    setLanguage("ru");
    const key = "Kept {kept} tasks";
    const forms = RU[key];
    expect(typeof forms).toBe("object");
    const say = (kept: number) => t(key, { kept });
    expect(new Set([say(1), say(2), say(5)]).size).toBe(3);
    expect(say(21).replace("21", "1")).toBe(say(1));
    expect(say(22).replace("22", "2")).toBe(say(2));
    expect(say(11).replace("11", "5")).toBe(say(5));
  });

  it("tn counts in English without a catalog", () => {
    expect(tn(1, "{count} message", "{count} messages")).toBe("1 message");
    expect(tn(3, "{count} message", "{count} messages")).toBe("3 messages");
  });
});

describe("resolveLanguage", () => {
  it("follows the setting, and the system when the setting says auto", () => {
    expect(resolveLanguage("ru", ["en-US"])).toBe("ru");
    expect(resolveLanguage("en", ["ru-RU"])).toBe("en");
    expect(resolveLanguage("auto", ["ru-RU", "en"])).toBe("ru");
    expect(resolveLanguage("auto", ["en-GB", "ru"])).toBe("ru");
    expect(resolveLanguage(undefined, ["de-DE"])).toBe("en");
    expect(resolveLanguage("auto", [])).toBe("en");
  });

  it("keeps the system's own date formats for an English page", () => {
    expect(dateLocale()).toBeUndefined();
    setLanguage("ru");
    expect(dateLocale()).toBe("ru-RU");
  });
});

describe("the Russian catalog", () => {
  const texts = pageTexts();

  it("has an entry for every text the pages show", () => {
    expect(texts.size).toBeGreaterThan(1000);
    const missing = [...texts.keys()].filter((text) => !(text in RU) && !UNTRANSLATED.has(text));
    expect(missing).toEqual([]);
  });

  it("keeps every value's placeholders among the English text's", () => {
    const wrong: string[] = [];
    for (const [key, entry] of Object.entries(RU)) {
      const allowed = new Set(placeholders(key));
      const values = typeof entry === "string" ? [entry] : Object.values(entry);
      for (const value of values) {
        if (placeholders(value as string).some((name) => !allowed.has(name))) wrong.push(key);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("is really Russian: every entry has Cyrillic letters and no markup", () => {
    const odd: string[] = [];
    for (const [key, entry] of Object.entries(RU)) {
      const values = typeof entry === "string" ? [entry] : Object.values(entry);
      for (const value of values) {
        if (!/[Ѐ-ӿ]/.test(value as string) || /<[a-z/]/i.test(value as string)) odd.push(key);
      }
    }
    expect(odd).toEqual([]);
  });

  it("is written with escapes only", () => {
    const source = readFileSync(join(here, "ru.ts"), "utf8");
    expect(/[^\x00-\x7f]/.test(source)).toBe(false);
  });
});
