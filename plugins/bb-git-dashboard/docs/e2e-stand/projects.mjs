// Browser probe of the Projects page (R3), after overview.mjs: every attached copy is a row under its category; the views
// count and filter the rows; a chosen copy is fetched with the selection's Fetch and the answer is shown; the column heads
// keep to one line in English and Russian, at 1440 and 768 px; the table scrolls inside the page. Shots of the page, light
// and dark, go to <outDir>. Usage: node projects.mjs <bbUrl> <toolsDir> <chrome> <outDir>. Last line is PASS or FAIL.
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = (locator, timeout = 15000) => locator.first().waitFor({ timeout }).then(() => true, () => false);
const side = page => page.getByRole("navigation", { name: "Makosh Git" });
// A head on one line is as tall as the shortest one; letters wrapping one per line make it several times taller.
const heads = page => page.locator(".git-projects-table thead th").evaluateAll(cells => cells.map(cell => [cell.textContent, cell.getBoundingClientRect().height]));
const oneLine = rows => rows.length > 1 && rows.every(([, height]) => height <= 40);
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
    check(theme + ": the page opens with its views", await visible(page.getByRole("heading", { name: "Projects", level: 1 }), 30000)
      && await visible(page.getByRole("tablist", { name: "Views" })));
    const table = page.locator(".git-projects-table");
    check(theme + ": the copies are rows of the table", await visible(table.getByRole("button", { name: "alpha", exact: true }), 60000)
      && await visible(table.getByRole("button", { name: "beta", exact: true })));
    if (theme === "light") {
      const tab = name => page.getByRole("tablist", { name: "Views" }).getByRole("tab", { name: new RegExp("^" + name) });
      check("the column heads keep to one line", oneLine(await heads(page)), await heads(page));
      await tab("With changes").click();
      check("With changes shows the copy with a changed file, and is the selected view", await visible(table.getByRole("button", { name: "alpha", exact: true }))
        && await tab("With changes").getAttribute("aria-selected") === "true");
      await tab("All").click();
      // Categories fold.
      const group = table.locator(".git-projects-group").first();
      await group.click();
      const body = table.locator("tbody").first();
      check("a category folds its rows away", await group.getAttribute("aria-expanded") === "false" && await body.locator("tr:not(.group)").count() === 0);
      await group.click();
      // Selection and Fetch.
      await table.getByRole("checkbox", { name: "Select beta" }).check();
      const bulk = page.getByRole("group", { name: "Selected 1" });
      check("choosing a copy offers Fetch and Pull for it", await visible(bulk.getByRole("button", { name: "Fetch" })) && await visible(bulk.getByRole("button", { name: "Pull" })));
      await bulk.getByRole("button", { name: "Fetch" }).click();
      check("the fetch answers for the chosen copy", await visible(page.getByRole("status").filter({ hasText: /^Fetch: / }), 60000));
      // The form to attach a copy opens under the head (every stand project's copy is attached already) and closes again.
      const attach = page.getByRole("button", { name: "Attach a copy", exact: true });
      await attach.click();
      check("Attach a copy opens its form", await visible(page.locator(".git-add-copy")) && await attach.getAttribute("aria-expanded") === "true");
      await attach.click();
      const work = table.locator("tbody").filter({ has: page.getByRole("button", { name: /^Hide Work$/ }) });
      check("a copy of a folder below the projects folder is a row under that category", await visible(work.getByRole("button", { name: "delta", exact: true }), 30000));
      await page.screenshot({ path: out + "/projects-light.png" });
      // The overview's head filters by category: Work has no pull request of mine, All has them again.
      await side(page).getByRole("button", { name: /^Overview\b/ }).click();
      const filter = page.getByRole("group", { name: "Category" });
      check("the overview offers its categories", await visible(filter.getByRole("button", { name: "All" }), 30000)
        && await visible(filter.getByRole("button", { name: "Work" })) && await visible(filter.getByRole("button", { name: "projects" })));
      const mine = page.getByText("Add greeting check");
      await mine.first().waitFor({ timeout: 60000 }).catch(() => {});
      await filter.getByRole("button", { name: "Work" }).click();
      const hidden = await mine.count() === 0;
      await page.screenshot({ path: out + "/overview-category-light.png" });
      await filter.getByRole("button", { name: "All" }).click();
      check("a category shows only its own: my pull request of another repository goes, and comes back under All", hidden && await visible(mine));
      await side(page).getByRole("button", { name: /^Projects\b/ }).click();
      await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
      // Russian.
      await side(page).getByRole("button", { name: "RU", exact: true }).click();
      check("in Russian the page's words are Russian", await visible(page.getByRole("heading", { name: "Проекты", level: 1 }))
        && await visible(page.getByRole("tab", { name: /^Требуют внимания/ })));
      check("in Russian the column heads keep to one line", oneLine(await heads(page)), await heads(page));
      await page.screenshot({ path: out + "/projects-ru-light.png" });
      await side(page).getByRole("button", { name: "EN", exact: true }).click();
      await page.waitForTimeout(800);
      // Narrow: the heads stay on one line, the table scrolls inside its own box.
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.waitForTimeout(500);
      check("at 768 px the column heads keep to one line", oneLine(await heads(page)), await heads(page));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check("at 768 px the page does not scroll sideways, the table does inside", overflow <= 0, overflow);
      await page.screenshot({ path: out + "/projects-768.png" });
    } else {
      await page.screenshot({ path: out + "/projects-dark.png" });
    }
    check(theme + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
