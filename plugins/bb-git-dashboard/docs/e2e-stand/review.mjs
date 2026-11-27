// Browser probe of pull request and issue pages over the Gitea and GitLab stand-ins: a Gitea pull request opened from
// My PRs with its conflict, failing check, discussion and review thread; a line comment and a comment through the
// confirmation dialog; a GitLab merge request's thread resolved, an approval pinned to the head, no request-changes
// review, a draft made ready; a GitLab issue with a comment and a new issue. Writes are checked in the stand-ins' logs.
// Usage: node review.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <repo>. Last line is PASS or FAIL.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const log = name => readFileSync(process.env.STAND + "/forge/" + name, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const gitea = () => log("writes.log").filter(write => /\/(pulls|issues)\b/.test(write.path));
const gitlab = () => log("gitlab-writes.log").filter(write => /\/(merge_requests|issues)\b/.test(write.path));
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
// Waits for a condition instead of a fixed pause: a loaded machine answers later.
const until = async (condition, timeout = 10000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 250)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
async function confirm(page, text) {
  const dialog = page.getByRole("dialog");
  const shown = await visible(dialog.getByText(text));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await dialog.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  return shown;
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  await page.goto(url + "plugins/bb-git-dashboard/git", { waitUntil: "load" });
  await page.getByRole("button", { name: /^Мои PR/ }).click({ timeout: 30000 });
  await page.locator(".git-inbox-item", { hasText: "Add greeting check" }).locator("a").first().click();
  const pr = page.getByRole("region", { name: "Pull request stand/beta #3" });
  const opened = await visible(pr.getByRole("heading", { name: /Add greeting check/ }));
  if (!opened) { await page.screenshot({ path: out + "/review-not-opened.png", fullPage: true }); console.log((await page.locator("body").innerText()).slice(0, 1200)); }
  check("a pull request opens inside Makosh Git", opened);
  check("its blockers and review are shown", await visible(pr.getByText("Merge conflicts")) && await visible(pr.getByText(/alice: changes requested/)));
  check("the discussion is listed as text", await visible(pr.getByText("Looks close.")) && await visible(pr.getByText("Typo on line 2.")));
  await pr.getByRole("navigation", { name: "Pull request sections" }).getByRole("button", { name: /^Checks/ }).click();
  check("the failing check offers Fix with agent", await visible(pr.locator("li", { hasText: "ci/test" }).getByRole("button", { name: "Fix with agent" })));
  await pr.getByRole("navigation", { name: "Pull request sections" }).getByRole("button", { name: /^Files/ }).click();
  check("the review thread sits under its line", await visible(pr.locator(".git-review-diff .git-review-thread", { hasText: "wrold?" })));
  await pr.getByRole("button", { name: "Comment on line 2", exact: true }).click();
  await pr.getByRole("textbox", { name: "Line comment" }).fill("Should read world.");
  await pr.locator(".git-review-composer").getByRole("button", { name: "Comment", exact: true }).click();
  check("a line comment is previewed with its place", await confirm(page, "Comment on src/greeting.txt line 2 of stand/beta #3"));
  const lineWrite = gitea().find(write => write.path.endsWith("/pulls/3/reviews"));
  check("and reaches Gitea as a review comment on the new line", lineWrite?.body?.comments?.[0]?.new_position === 2 && lineWrite?.body?.commit_id === "e".repeat(40), lineWrite);
  await page.screenshot({ path: out + "/review-files.png", fullPage: true });
  await pr.getByRole("navigation", { name: "Pull request sections" }).getByRole("button", { name: "Overview" }).click();
  await pr.getByRole("textbox", { name: "Comment" }).fill("Thanks!");
  await pr.getByRole("button", { name: "Comment", exact: true }).click();
  check("a comment is previewed", await confirm(page, "Comment on stand/beta #3"));
  check("and reaches Gitea once", gitea().filter(write => write.path.endsWith("/issues/3/comments")).length === 1);

  await page.getByRole("button", { name: "My PRs" }).click();
  await page.locator(".git-inbox-item", { hasText: "Retry flaky test" }).locator("a").first().click();
  const mr = page.getByRole("region", { name: "Pull request stand/gamma #5" });
  check("a GitLab merge request opens", await visible(mr.getByRole("heading", { name: /Retry flaky test/ })));
  await mr.getByRole("navigation", { name: "Pull request sections" }).getByRole("button", { name: /^Comments/ }).click();
  await mr.getByRole("button", { name: "Resolve" }).click();
  check("resolving a thread is previewed", await confirm(page, "Resolve a review thread on stand/gamma #5"));
  check("and resolves the GitLab discussion", JSON.stringify(gitlab().at(-1)) === JSON.stringify({method: "PUT", path: "/api/v4/projects/7/merge_requests/5/discussions/disc-1", body: {resolved: true}}), gitlab().at(-1));
  // Approving needs a merge request by someone else: !8 asks for my review.
  await page.getByRole("button", { name: "My PRs" }).click();
  await page.getByRole("navigation", { name: "Pull request tabs" }).getByRole("button", { name: /^Review requested/ }).click();
  await page.locator(".git-inbox-item", { hasText: "Rename variables" }).locator("a").first().click();
  const other = page.getByRole("region", { name: "Pull request stand/gamma #8" });
  await other.getByRole("navigation", { name: "Pull request sections" }).getByRole("button", { name: /^Files/ }).click({ timeout: 20000 });
  const outcome = other.getByRole("combobox", { name: "Review outcome" });
  check("GitLab offers no request-changes review", await visible(outcome) && !(await outcome.locator("option").allInnerTexts()).includes("Request changes"));
  await outcome.selectOption("APPROVE");
  await other.getByRole("button", { name: "Submit review" }).click();
  check("an approval is previewed", await confirm(page, "Approve on stand/gamma #8"));
  const approve = gitlab().find(write => write.path.endsWith("/merge_requests/8/approve"));
  check("and is pinned to the reviewed head", approve?.body?.sha === "d".repeat(40), approve);

  await page.getByRole("button", { name: "My PRs" }).click();
  await page.locator(".git-inbox-item", { hasText: "Follow-up on retries" }).locator("a").first().click();
  const draft = page.getByRole("region", { name: "Pull request stand/gamma #6" });
  await draft.getByRole("button", { name: "Ready for review" }).click({ timeout: 20000 });
  check("Ready for review is previewed", await confirm(page, "Mark stand/gamma #6 ready for review"));
  check("and drops GitLab's Draft: prefix", JSON.stringify(gitlab().at(-1)?.body) === JSON.stringify({title: "Follow-up on retries"}), gitlab().at(-1));

  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "+ Подключить копию" }).click({ timeout: 30000 });
  const select = page.locator(".git-add-copy select").first();
  const value = await select.locator("option").evaluateAll(options => options.find(option => option.textContent.trim().endsWith("/gamma"))?.value ?? "");
  // gitlab.mjs may have attached it already: then the form is closed again rather than left over the page.
  if (value) { await select.selectOption(value); await page.getByRole("button", { name: "Подключить и показать worktree" }).click(); }
  else await page.getByRole("button", { name: "+ Подключить копию" }).click();
  const sections = page.getByRole("navigation", { name: "Repository sections" });
  const openGamma = async () => {
    for (let attempt = 0; attempt < 3 && await sections.count() === 0; attempt++) {
      await page.locator("button.git-table-entry", { hasText: "gamma" }).first().click();
      await until(async () => await sections.count() > 0, 5000);
    }
    await sections.getByRole("button", { name: "Issues" }).click();
  };
  await openGamma();
  await page.getByRole("button", { name: "#4 Greeting is wrong" }).click({ timeout: 20000 });
  const issue = page.getByRole("region", { name: "Issue stand/gamma #4" });
  check("an issue opens with its comments", await visible(issue.getByText("It says wrold.")) && await visible(issue.getByText("Confirmed.")));
  await issue.getByRole("textbox", { name: "Comment" }).fill("Fixed in !5.");
  await issue.getByRole("button", { name: "Comment", exact: true }).click();
  check("an issue comment is previewed", await confirm(page, "Comment on stand/gamma issue #4"));
  check("and reaches GitLab", gitlab().some(write => write.path.endsWith("/issues/4/notes") && write.body?.body === "Fixed in !5."));
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await openGamma();
  await page.getByRole("button", { name: "New issue" }).click({ timeout: 20000 });
  await page.getByRole("textbox", { name: "Issue title" }).fill("Add a backoff");
  await page.getByRole("button", { name: "Open issue" }).click();
  check("a new issue is previewed", await confirm(page, "Open an issue in stand/gamma: “Add a backoff”"));
  check("and is created on GitLab", gitlab().some(write => write.method === "POST" && write.path === "/api/v4/projects/7/issues" && write.body?.title === "Add a backoff"));

  await page.setViewportSize({ width: 768, height: 900 });
  await page.getByRole("button", { name: "My PRs" }).click().catch(() => {});
  await page.locator(".git-inbox-item", { hasText: "Add greeting check" }).locator("a").first().click().catch(() => {});
  await page.waitForTimeout(800);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  await page.screenshot({ path: out + "/review-768.png", fullPage: true });
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  await browser.contexts()[0]?.pages()[0]?.screenshot({ path: out + "/review-failure.png", fullPage: true }).catch(() => {});
  check("probe ran to the end", false, String(error).slice(0, 600));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
