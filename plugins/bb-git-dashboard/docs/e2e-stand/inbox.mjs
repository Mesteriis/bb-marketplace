// Browser probe of My PRs against the Gitea and GitLab stand-ins: tabs and counts over both accounts, blockers and
// their stripe, stacks, search, j/k, hiding a repository, Review requested and Merged, then the watcher's alert when
// a merge request's pipeline starts failing (toast, New since you last looked, the badge, Mark as seen).
// Usage: node inbox.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <repo>. Last line is PASS or FAIL.
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
  await page.goto(url + "plugins/bb-git-dashboard/git", { waitUntil: "load" });
  await page.getByRole("button", { name: /^Мои PR/ }).click({ timeout: 30000 });
  const tabs = page.getByRole("navigation", { name: "Pull request tabs" });
  const row = title => page.locator(".git-inbox-item", { hasText: title });
  check("both accounts are listed", await visible(page.getByRole("heading", { name: "stand Gitea" })) && await visible(page.getByRole("heading", { name: "stand GitLab" })));
  check("Open counts both accounts", (await tabs.getByRole("button", { name: /^Open/ }).innerText()).replace(/\s+/g, "") === "Open3");
  check("Review requested counts both accounts", (await tabs.getByRole("button", { name: /^Review requested/ }).innerText()).replace(/\s+/g, "") === "Reviewrequested2");
  const greeting = row("Add greeting check");
  check("a conflicting PR with failing CI is red and says why", await visible(greeting) && await greeting.getAttribute("data-severity") === "red" &&
    /Merge conflicts/.test(await greeting.innerText()) && /CI failing \(1 check\)/.test(await greeting.innerText()) && /\+12\s*−3/.test(await greeting.innerText()));
  check("a running pipeline is amber", await row("Retry flaky test").getAttribute("data-severity") === "amber" && /CI running/.test(await row("Retry flaky test").innerText()));
  check("a merge request on another one's branch is stacked on it", /Draft/.test(await row("Follow-up on retries").innerText()) && /Stacked on #5/.test(await row("Follow-up on retries").innerText()));
  check("a row opens the forge page", /\/stand\/beta\/pulls\/3$/.test(await greeting.locator("a").getAttribute("href") ?? ""));
  await page.screenshot({ path: out + "/inbox-open.png", fullPage: true });

  await page.locator(".git-inbox").press("j");
  check("j moves to the first row", await page.locator(".git-inbox-item[data-current]").count() === 1);
  await page.getByRole("searchbox", { name: "Search pull requests" }).fill("follow");
  check("search keeps only matching rows", await page.locator(".git-inbox-item").count() === 1 && await row("Follow-up on retries").count() === 1);
  await page.getByRole("searchbox", { name: "Search pull requests" }).fill("");
  await page.locator(".git-inbox-repo", { hasText: "stand/beta" }).getByRole("button", { name: "Hide" }).click();
  check("a hidden repository leaves the tab and says so", await greeting.count() === 0 && await visible(page.getByText(/1 hidden repository on this tab/)));
  await page.getByRole("button", { name: "Show all" }).click();
  check("Show all brings it back", await visible(greeting));

  await tabs.getByRole("button", { name: /^Review requested/ }).click();
  check("Review requested lists both forges", await visible(row("Tidy README")) && await visible(row("Rename variables")) && /Changes requested/.test(await row("Rename variables").innerText()));
  await tabs.getByRole("button", { name: /^Merged/ }).click();
  check("Merged lists the merged PR without blockers", await visible(row("Initial import")) && await row("Initial import").locator(".git-inbox-blocker").count() === 0);
  await tabs.getByRole("button", { name: /^Open/ }).click();

  const alert = page.getByText("CI failing · stand/gamma#5");
  check("the watcher alerts when the pipeline starts failing", await visible(alert, 240000));
  check("the alert arrives as a toast", await page.locator(".git-inbox-toast", { hasText: "CI failing · stand/gamma#5" }).count() === 1);
  check("and in New since you last looked", await visible(page.getByRole("region", { name: "New since you last looked" })));
  await page.screenshot({ path: out + "/inbox-alert.png", fullPage: true });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  check("the My PRs button counts the unseen alert", (await page.getByRole("button", { name: /^Мои PR/ }).innerText()).replace(/\s+/g, "") === "МоиPR1");
  await page.getByRole("button", { name: /^Мои PR/ }).click();
  await page.getByRole("button", { name: "Mark as seen" }).click();
  check("Mark as seen clears the list", await page.getByRole("region", { name: "New since you last looked" }).count() === 0 ||
    await page.getByRole("region", { name: "New since you last looked" }).waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false));
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  check("and the badge", (await page.getByRole("button", { name: /^Мои PR/ }).innerText()).replace(/\s+/g, "") === "МоиPR");

  await page.getByRole("button", { name: /^Мои PR/ }).click();
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  await page.screenshot({ path: out + "/inbox-768.png", fullPage: true });
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
