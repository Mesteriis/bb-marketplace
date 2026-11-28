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
  let entry = page.locator(".git-projects-table").getByRole("button", { name: "alpha", exact: true }).first();
  if (!await visible(entry, 8000)) {
    await page.getByRole("button", { name: "Attach a copy", exact: true }).click({ timeout: 30000 });
    const select = page.locator(".git-add-copy select").first();
    if (await select.count()) await select.selectOption(await select.locator("option").evaluateAll(options => options.find(option => option.textContent.trim().endsWith("/alpha"))?.value ?? ""));
    await page.getByRole("button", { name: "Attach and open" }).click(); await page.waitForURL(address => !address.pathname.endsWith("/git/projects"), { timeout: 30000 }).catch(() => {}); await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
    entry = page.locator(".git-projects-table").getByRole("button", { name: "alpha", exact: true }).first();
  }
  check("copy listed", await visible(entry));
  await entry.click();
  await page.getByRole("tablist", { name: "Project sections" }).getByRole("tab", { name: "History" }).click();
  check("the bar counts the commits and names the branch", await visible(page.locator(".git-history-bar").getByText("5 commits · on main")));
  const edge = await page.locator(".git-history-bar").evaluate(bar => bar.getBoundingClientRect().left - bar.closest(".g-page").getBoundingClientRect().left).catch(() => -1);
  check("the history runs edge to edge under the tabs, as on the reference", edge === 0, edge);
  const merge = page.locator(".git-history-row", { hasText: "merge feature" });
  check("merge commit carries the current branch and the tag", await visible(merge) &&
    await merge.locator(".git-history-ref[data-head]", { hasText: "main" }).count() === 1 && await merge.locator(".git-history-ref[data-kind=tag]", { hasText: "v1.0" }).count() === 1);
  const width = Number(await page.locator(".git-history-graph").first().getAttribute("width"));
  check("graph draws more than one lane", width >= 30, width);
  check("side branch is part of the graph", await page.locator(".git-history-row", { hasText: "side tip" }).count() === 1);
  check("each commit says who and how long ago", /^stand · (just now|\d+ (min|h)|\d+ days?)$/.test((await merge.locator(".git-history-meta").innerText()).trim()),
    await merge.locator(".git-history-meta").innerText());
  const change = page.locator(".git-history-change");
  check("uncommitted change opens first with its numbered diff", await visible(page.getByRole("region", { name: "Uncommitted changes" })) &&
    await visible(change.locator(".git-review-row[data-kind=add]", { hasText: "b" })) && await visible(change.locator(".git-review-row[data-kind=add] .git-review-number").nth(1)));
  await page.screenshot({ path: out + "/project-history-light.png" });
  await page.locator(".git-history-row", { hasText: "feature work" }).click();
  const commit = page.getByRole("region", { name: "Commit" });
  check("a commit shows its facts: hash, author, parent and changes", await visible(commit.getByRole("heading", { name: "feature work" })) &&
    await visible(commit.getByRole("term").filter({ hasText: "Commit" })) && await visible(commit.getByRole("term").filter({ hasText: "Parent" })) &&
    /^1 file · \+1 −0$/.test((await commit.locator("dd").nth(3).textContent()).replace(/\s+/g, " ").trim()), await commit.locator("dd").allTextContents().catch(() => []));
  check("a commit shows its files and the chosen file's diff", await visible(commit.getByRole("list", { name: "Changed files" }).getByText("feature.txt")) &&
    await visible(commit.locator(".git-review-row[data-kind=add]", { hasText: "2" })));
  const wrap = commit.getByRole("button", { name: "Wrap lines" });
  await wrap.click();
  check("Wrap lines wraps the diff", await wrap.getAttribute("aria-pressed") === "true" && await commit.locator(".git-history-diff[data-wrap]").count() === 1);
  await page.getByRole("group", { name: "Which commits" }).getByRole("button", { name: "Current only" }).click();
  check("Current only leaves HEAD's history: the side branch goes", await page.locator(".git-history-row", { hasText: "side tip" }).count() === 0
    && await page.locator(".git-history-row", { hasText: "feature work" }).count() === 1);
  await page.getByRole("group", { name: "Which commits" }).getByRole("button", { name: "All branches" }).click();
  const search = page.getByRole("searchbox", { name: "Find in loaded commits" });
  await search.fill("feature");
  check("search counts its matches", await visible(page.locator(".git-history-bar").getByText(/^\d+ match(es)?$/)), await page.locator(".git-history-bar [role=status]").textContent().catch(() => null));
  check("search marks matching rows and dims the rest", await page.locator(".git-history-rows li[data-match]").count() >= 1 &&
    await page.locator(".git-history-rows li[data-index]:not([data-match])").count() >= 1);
  await search.press("Enter");
  check("Enter selects a match", await page.locator(".git-history-rows li[data-match] .git-history-row[aria-current=true]").count() === 1);
  await search.fill("");
  await page.getByRole("button", { name: "Refresh" }).first().click();
  check("Refresh reloads the history", await visible(page.getByRole("button", { name: "Refresh" }).first()) &&
    await visible(page.locator(".git-history-bar").getByText("5 commits · on main")));
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
