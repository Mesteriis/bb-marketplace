// Browser probe of the CI/CD screens in the dark theme and in Russian, after ci.mjs (the copy "beta" is attached and
// linked to the Gitea stand-in): the CI/CD section, a copy's CI/CD tab, a run, the run dialog and the templates. It
// sends nothing to the forge (the run dialog is closed with Cancel) and puts the language back to English at the end.
// Usage: node ci-shots.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND = stand directory). Last line is PASS or FAIL.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const writes = () => readFileSync(process.env.STAND + "/forge/writes.log", "utf8").trim().split("\n").filter(Boolean).length;
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
const side = page => page.getByRole("navigation", { name: "Makosh Git" });
// The words of each language: the section, the tab, the run page, the dialog and the templates.
const words = {
  en: {section: "CI/CD", run: "Run workflow…", runWith: "Run with inputs…", dialog: "Run workflow", cancel: "Cancel", templates: "Templates", back: "Back to runs",
    rerun: "Re-run failed jobs", notify: "Notify about failures", tab: "CI/CD", sections: "Project sections", path: "Path", failed: /^CI #2\b/},
  ru: {section: "CI/CD", run: "Запустить workflow…", runWith: "Запустить с параметрами…", dialog: "Запустить workflow", cancel: "Отмена", templates: "Шаблоны",
    back: "Назад к запускам", rerun: "Перезапустить упавшие", notify: "Уведомлять о падениях", tab: "CI/CD", sections: "Разделы проекта", path: "Путь", failed: /^CI #2\b/},
};
const before = writes();
try {
  for (const [theme, language] of [["dark", "en"], ["light", "ru"]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    const w = words[language];
    const tag = language === "ru" ? "ru-" + theme : theme;
    await page.goto(url + "plugins/bb-git-dashboard/git/ci", { waitUntil: "load" });
    await side(page).getByRole("button", { name: language.toUpperCase(), exact: true }).click({ timeout: 30000 });
    check(tag + ": the CI/CD section", await visible(page.getByRole("heading", { level: 1, name: w.section }), 30000) && await visible(page.locator(".git-ci-row").first(), 60000));
    await page.waitForTimeout(600);
    await page.screenshot({ path: out + "/ci-" + tag + ".png" });
    await page.locator(".git-ci-row").filter({ has: page.getByRole("button", { name: w.failed }) }).first().click();
    check(tag + ": the run page", await visible(page.getByRole("button", { name: w.rerun })) && await visible(page.locator(".git-ci-line[data-error]")));
    await page.waitForTimeout(600);
    await page.screenshot({ path: out + "/ci-run-" + tag + ".png" });
    await page.getByRole("button", { name: w.runWith }).click();
    const dialog = page.getByRole("dialog", { name: w.dialog });
    check(tag + ": the run dialog with what will be sent", await visible(dialog.locator(".git-ci-sends li"), 20000));
    await page.waitForTimeout(400);
    await page.screenshot({ path: out + "/ci-dispatch-" + tag + ".png" });
    await dialog.getByRole("button", { name: w.cancel }).click();
    await page.getByRole("navigation", { name: w.path }).getByRole("button", { name: "beta" }).click();
    check(tag + ": the copy's CI/CD tab", await visible(page.getByRole("tab", { name: w.tab, selected: true })) && await visible(page.getByRole("button", { name: new RegExp("^" + w.notify + ": ") })));
    await page.locator(".git-ci-row").first().waitFor({ timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: out + "/project-actions-" + tag + ".png" });
    await page.getByRole("button", { name: w.templates, exact: true }).click();
    check(tag + ": the templates", await visible(page.getByRole("button", { name: w.back })) && await visible(page.locator(".git-ci-tpl-code .git-ci-line").first(), 30000));
    await page.waitForTimeout(400);
    await page.screenshot({ path: out + "/project-ci-templates-" + tag + ".png" });
    const narrow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(tag + ": no sideways scroll", narrow <= 0, narrow);
    if (language !== "en") await side(page).getByRole("button", { name: "EN", exact: true }).click();
    await page.waitForTimeout(500);
    check(tag + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
  check("nothing was sent to the forge", writes() === before, writes() - before);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 400));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
