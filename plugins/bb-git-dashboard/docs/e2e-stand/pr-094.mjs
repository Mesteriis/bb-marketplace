// Browser probe of 0.9.4: Prev / Next and "N of M" on a pull request opened from My PRs; Unresolved / Resolved and
// "N waiting on your reply" on Comments of the GitLab merge request !5; a test alert sent from the plugin's settings
// shows a toast outside the Git panel whose Open goes to My PRs, and Git's navigation entry carries the unread count.
// Usage: node pr-094.mjs <bbUrl> <toolsDir> <chrome> <outDir>. Last line is PASS or FAIL.
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const until = async (condition, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 250)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: /^My PRs\b/ }).click({ timeout: 30000 });
  const inbox = page.getByRole("region", { name: "My pull requests" });
  await inbox.getByRole("tablist", { name: "Pull request tabs" }).getByRole("tab", { name: /^Open/ }).click();
  await inbox.getByLabel("Search pull requests").fill("");
  const rows = inbox.locator(".git-inbox-item");
  await until(async () => await rows.count() >= 3);
  const titles = await rows.locator(".git-inbox-title").allInnerTexts();
  const at = titles.findIndex(title => title.includes("Retry flaky test"));
  await rows.nth(at).locator("a").first().click();

  const step = page.getByRole("group", { name: "Pull requests of the list" });
  check("the pull request says where it is in the list", await visible(step.getByText((at + 1) + " of " + titles.length, { exact: true })), titles);
  const next = titles[at + 1], previous = titles[at - 1];
  if (next) {
    await step.getByRole("button", { name: "Next" }).click();
    check("Next opens the following one", await visible(page.getByRole("heading", { name: new RegExp(next.replace(/[[\]]/g, ".")) })), next);
    await page.getByRole("group", { name: "Pull requests of the list" }).getByRole("button", { name: "Prev" }).click();
  } else if (previous) {
    await step.getByRole("button", { name: "Prev" }).click();
    check("Prev opens the one before", await visible(page.getByRole("heading", { name: new RegExp(previous.replace(/[[\]]/g, ".")) })), previous);
    await page.getByRole("group", { name: "Pull requests of the list" }).getByRole("button", { name: "Next" }).click();
  }
  const mr = page.getByRole("region", { name: "Pull request stand/gamma #5" });
  check("and back again", await visible(mr.getByRole("heading", { name: /Retry flaky test/ })));
  const first = await page.getByRole("group", { name: "Pull requests of the list" }).getByRole("button", { name: "Prev" }).isDisabled();
  check("Prev is off on the first row only", first === (at === 0), {at, first});

  await mr.getByRole("tablist", { name: "Pull request sections" }).getByRole("tab", { name: /^Comments/ }).click();
  const filter = mr.getByRole("group", { name: "Thread status" });
  check("Comments shows the open threads first, with their count", await visible(filter.getByRole("button", { name: /^Open\s*1/ }))
    && await filter.getByRole("button", { name: /^Open/ }).getAttribute("aria-pressed") === "true"
    && await visible(mr.locator(".git-pr-thread", { hasText: "Why retry three times?" })));
  check("on your own merge request it counts what waits on your reply", await visible(mr.getByText("1 waiting on your reply")));
  await filter.getByRole("button", { name: /^Resolved/ }).click();
  check("Resolved lists none here", await visible(mr.getByText("No resolved threads yet.")) && await mr.locator(".git-pr-thread").count() === 0);
  await page.screenshot({ path: out + "/pr-094-comments.png", fullPage: false });

  await page.goto(url + "settings/plugins/bb-git-dashboard", { waitUntil: "load" });
  await page.getByRole("button", { name: "Send test notification" }).click({ timeout: 30000 });
  const toast = page.locator(".git-inbox-toast", { hasText: "Test alert from Makosh Git" });
  check("a new alert shows as a toast outside the Git panel", await visible(toast, 15000));
  check("Git's navigation entry carries the unread count", await until(async () =>
    await page.locator("[aria-label*='new pull request alert'], [title*='new pull request alert']").count() > 0));
  await toast.getByRole("button", { name: "Open" }).click();
  check("Open on the toast goes to My PRs", await until(async () => /plugins\/bb-git-dashboard\/git\/inbox/.test(page.url())), page.url());
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 1500));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
