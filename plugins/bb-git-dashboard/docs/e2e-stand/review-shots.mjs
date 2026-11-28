// Browser probe of the review and history screens in light and dark, English and Russian, after code-review-runs.mjs
// (stand-beta has a line review with threads): the Reviews page, a copy's Review with the AI review dialog (closed with
// Cancel, nothing started) and its History. Puts the language back to English at the end.
// Usage: node review-shots.mjs <bbUrl> <toolsDir> <chrome> <outDir>. Last line is PASS or FAIL.
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
const side = page => page.getByRole("navigation", { name: "Makosh Git" });
const words = {
  en: {reviews: "Reviews", review: "Review", history: "History", sections: "Project sections", ai: "AI review", cancel: "Cancel", copy: "Working copy", files: "Files"},
  ru: {reviews: "Ревью", review: "Ревью", history: "История", sections: "Разделы проекта", ai: "ИИ-ревью", cancel: "Отмена", copy: "Рабочая копия", files: "Файлы"},
};
try {
  for (const [theme, language] of [["light", "en"], ["dark", "en"], ["light", "ru"]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    const w = words[language];
    const tag = (language === "ru" ? "ru-" : "") + theme;
    await page.goto(url + "plugins/bb-git-dashboard/git/reviews", { waitUntil: "load" });
    await side(page).getByRole("button", { name: language.toUpperCase(), exact: true }).click({ timeout: 30000 });
    const table = page.locator(".git-reviews-table");
    check(tag + ": Reviews is one table of the reviews", await visible(page.getByRole("heading", { level: 1, name: w.reviews }), 30000)
      && await visible(table.getByRole("columnheader", { name: w.copy }), 30000) && await visible(table.locator(".git-reviews-row").first()));
    await page.waitForTimeout(500);
    await page.screenshot({ path: out + "/reviews-" + tag + ".png" });
    // A row opens that copy's review.
    await table.locator(".git-reviews-row", { hasText: "beta" }).first().click();
    const review = page.locator("section.git-code-review");
    check(tag + ": a row opens the copy's Review with its files beside the diff", await visible(review.getByRole("navigation", { name: w.files }), 30000)
      && await visible(review.locator(".git-review-file").first(), 30000));
    await page.waitForTimeout(800);
    await page.screenshot({ path: out + "/project-review-" + tag + ".png" });
    await review.getByRole("button", { name: w.ai, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: w.ai });
    check(tag + ": AI review is a dialog with its focuses", await visible(dialog) && await dialog.locator(".git-ai-chip").count() === 6);
    await page.waitForTimeout(600);
    await page.screenshot({ path: out + "/project-review-ai-" + tag + ".png" });
    if (theme === "light" && language === "en") {
      // BB's model picker inside the modal dialog: its list opens on top and takes a click, rather than hiding behind it.
      const picker = dialog.locator(".git-code-review-execution button").first();
      if (await visible(picker, 15000)) {
        await picker.click();
        await page.waitForTimeout(700);
        // What opened: a new element with real size, outside our dialog, under the point at its middle.
        const found = await page.evaluate(() => {
          const ours = document.querySelector(".g-dialog[open]");
          const candidates = [...document.querySelectorAll("[role=listbox], [role=menu], [role=dialog], [data-radix-popper-content-wrapper], [data-state=open]")]
            .filter(element => !ours?.contains(element) && element !== ours && element.getBoundingClientRect().width > 40 && element.getBoundingClientRect().height > 40);
          const element = candidates.at(-1);
          if (!element) return {opened: false, onTop: false, what: null};
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          const style = getComputedStyle(element);
          return {opened: true, onTop: !!hit && element.contains(hit) && style.visibility !== "hidden" && Number(style.opacity) > 0.5,
            what: element.tagName + "." + String(element.className).slice(0, 60) + " " + Math.round(box.width) + "x" + Math.round(box.height), hit: hit?.tagName + "." + String(hit?.className).slice(0, 40)};
        });
        const opened = found.opened, onTop = found.onTop;
        await page.screenshot({ path: out + "/project-review-ai-picker.png" });
        check("the model picker opens on top of the dialog and takes a click", opened && onTop, found);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        check("Escape closes the picker first, the dialog stays", await dialog.isVisible());
      } else check("the model picker is in the dialog", false);
    }
    await dialog.getByRole("button", { name: w.cancel, exact: true }).click();
    await page.getByRole("tablist", { name: w.sections }).getByRole("tab", { name: w.history }).click();
    check(tag + ": History shows the graph and the chosen change", await visible(page.locator(".git-history-row").first(), 30000) && await visible(page.locator(".git-history-change")));
    await page.waitForTimeout(800);
    await page.screenshot({ path: out + "/project-history-" + tag + ".png" });
    if (language !== "en") await side(page).getByRole("button", { name: "EN", exact: true }).click();
    await page.waitForTimeout(400);
    check(tag + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 400));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
