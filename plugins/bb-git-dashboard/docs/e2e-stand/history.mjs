// Browser probe of the History tab on stand-alpha: the graph over all refs with labels, the uncommitted change on
// top with its patch, a commit's files and patch, layout at 768 px. Last line is PASS or FAIL.
// Usage: node history.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <repo>
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  let entry = page.locator("button.git-table-entry", { hasText: "alpha" }).first();
  if (!await visible(entry, 8000)) {
    await page.getByRole("button", { name: "+ Подключить копию" }).click({ timeout: 30000 });
    const select = page.locator(".git-add-copy select").first();
    if (await select.count()) await select.selectOption(await select.locator("option").evaluateAll(options => options.find(option => option.textContent.trim().endsWith("/alpha"))?.value ?? ""));
    await page.getByRole("button", { name: "Подключить и показать worktree" }).click();
    entry = page.locator("button.git-table-entry", { hasText: "alpha" }).first();
  }
  check("copy listed", await visible(entry));
  await entry.click();
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("button", { name: "History" }).click();
  check("history counts commits on all branches", await visible(page.getByText("5 commits on all branches · on main")));
  const gap = await page.locator(".git-history-list").evaluate(list => list.getBoundingClientRect().left - (list.closest("main") ?? list.parentElement).getBoundingClientRect().left).catch(() => 0);
  check("history keeps the panel's inner spacing", gap >= 8, gap);
  const merge = page.locator(".git-history-row", { hasText: "merge feature" });
  check("merge commit carries the current branch and the tag", await visible(merge) &&
    await merge.locator(".git-history-ref[data-head]", { hasText: "main" }).count() === 1 && await merge.locator(".git-history-ref[data-kind=tag]", { hasText: "v1.0" }).count() === 1);
  const width = Number(await page.locator(".git-history-graph").first().getAttribute("width"));
  check("graph draws more than one lane", width >= 30, width);
  check("side branch is part of the graph", await page.locator(".git-history-row", { hasText: "side tip" }).count() === 1);
  check("uncommitted change opens first with its patch", await visible(page.getByRole("region", { name: "Uncommitted changes" })) &&
    await visible(page.locator(".git-history-patch .git-added", { hasText: "+b" })));
  await page.screenshot({ path: out + "/history-1440.png", fullPage: true });
  await page.locator(".git-history-row", { hasText: "feature work" }).click();
  check("a commit shows its files and patch", await visible(page.getByRole("region", { name: "Commit" }).getByText("feature.txt")) &&
    await visible(page.locator(".git-history-patch .git-added", { hasText: "+2" })));
  const patch = page.getByRole("region", { name: "Commit" });
  check("a patch counts its changed lines", await visible(patch.getByText(/^\d+ changed lines?$/)) && await visible(patch.locator(".git-history-patch-head .git-added")));
  await patch.getByLabel("Wrap long lines").check();
  check("Wrap long lines wraps the patch", await patch.locator(".git-history-patch[data-wrap]").count() === 1);
  check("commits are grouped by day", await page.locator(".git-history-day").count() >= 1);
  const search = page.getByRole("searchbox", { name: "Find in loaded commits" });
  await search.fill("feature");
  check("search counts its matches", await visible(page.getByText(/^\d+ match(es)? *$/)), await page.locator(".git-history-search [role=status]").textContent().catch(() => null));
  check("search marks matching rows and dims the rest", await page.locator(".git-history-rows li[data-match]").count() >= 1 &&
    await page.locator(".git-history-rows li[data-index]:not([data-match])").count() >= 1);
  await search.press("Enter");
  check("Enter selects a match", await page.locator(".git-history-rows li[data-match] .git-history-row[aria-current=true]").count() === 1);
  await search.fill("");
  await page.getByRole("button", { name: "Refresh" }).first().click();
  check("Refresh reloads the history", await visible(page.getByRole("button", { name: "Refresh" }).first()) &&
    await visible(page.getByText("5 commits on all branches · on main")));
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  await page.screenshot({ path: out + "/history-768.png", fullPage: true });
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
