// Browser probe of My PRs and the pull request page (R4), after inbox.mjs: My PRs has the head of every section and
// the blocker chips; the pull request page has its path, its place in the list, the five tabs as a tablist, what keeps
// it from merging with each line leading to its tab, and the review beside the Comments. Shots of each tab, light and
// dark, and My PRs and Overview in Russian, go to <outDir>. Usage: node prs.mjs <bbUrl> <toolsDir> <chrome> <outDir>.
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = (locator, timeout = 15000) => locator.first().waitFor({ timeout }).then(() => true, () => false);
const side = page => page.getByRole("navigation", { name: "Makosh Git" });
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(url + "plugins/bb-git-dashboard/git/inbox", { waitUntil: "load" });
    const inbox = page.getByRole("region", { name: "My pull requests" });
    check(theme + ": My PRs has the head of every section and the blocker chips", await visible(page.getByRole("heading", { name: "My PRs", level: 1 }), 30000)
      && await visible(inbox.getByRole("group", { name: "Blockers" })));
    const row = inbox.locator(".git-inbox-item", { hasText: "Add greeting check" });
    await row.waitFor({ timeout: 60000 }).catch(() => {});
    await page.screenshot({ path: out + "/my-prs-" + theme + ".png" });
    await row.locator("a").first().click();
    const pr = page.getByRole("region", { name: "Pull request stand/beta #3" });
    const tabs = pr.getByRole("tablist", { name: "Pull request sections" });
    check(theme + ": the pull request page has its path, its tabs and what keeps it from merging", await visible(pr.getByRole("heading", { name: /Add greeting check/, level: 1 }), 30000)
      && await visible(pr.getByRole("navigation", { name: "Path" })) && await tabs.getByRole("tab").count() === 5
      && await visible(pr.getByRole("complementary", { name: "What keeps it from merging" }).getByText(/Conflicts with main/)));
    await page.waitForTimeout(800);
    if (theme === "light") {
      const forge = await pr.getByRole("link", { name: "Open on Gitea" }).evaluate(link => ({line: getComputedStyle(link).textDecorationLine, display: getComputedStyle(link).display,
        icon: Boolean(link.querySelector("[data-icon=ExternalLink]"))}));
      check("Open on the forge is a ghost button with the external-link mark, not an underlined link", forge.line === "none" && forge.display === "inline-flex" && forge.icon, forge);
    }
    await page.screenshot({ path: out + "/pr-overview-" + theme + ".png" });
    if (theme === "light") {
      const blockers = pr.getByRole("complementary", { name: "What keeps it from merging" });
      await blockers.getByRole("button", { name: "Log" }).click();
      check("the CI line leads to Checks", await tabs.getByRole("tab", { name: /^Checks/ }).getAttribute("aria-selected") === "true");
    }
    for (const name of ["Checks", "Files", "Commits", "Comments"]) {
      await tabs.getByRole("tab", { name: new RegExp("^" + name) }).click();
      await page.waitForTimeout(name === "Files" ? 2500 : 1000);
      await page.screenshot({ path: out + "/pr-" + name.toLowerCase() + "-" + theme + ".png" });
    }
    check(theme + ": Comments has your review beside the threads", await visible(pr.getByRole("complementary", { name: "Your review" })));
    if (theme === "light") {
      await side(page).getByRole("button", { name: "RU", exact: true }).click();
      await tabs.getByRole("tab", { name: /^Обзор/ }).click().catch(() => {});
      await page.waitForTimeout(1000);
      check("in Russian the page's words are Russian", await visible(pr.getByRole("tab", { name: /^Проверки/ })));
      await page.screenshot({ path: out + "/pr-overview-ru-light.png" });
      await page.getByRole("tab", { name: /^Комментарии/ }).click();
      const outcome = page.getByRole("group", { name: "Итог ревью" }).getByRole("button");
      await outcome.first().waitFor({ timeout: 15000 }).catch(() => {});
      const heights = await outcome.evaluateAll(list => list.map(button => [button.textContent, button.getBoundingClientRect().height]));
      check("in Russian each review outcome keeps to one line", heights.length === 3 && heights.every(([, height]) => height <= 28), heights);
      await page.screenshot({ path: out + "/pr-comments-ru-light.png" });
      await side(page).getByRole("button", { name: /^Мои PR/ }).click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: out + "/my-prs-ru-light.png" });
      await side(page).getByRole("button", { name: "EN", exact: true }).click();
      await page.waitForTimeout(800);
    }
    check(theme + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
