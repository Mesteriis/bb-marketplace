// Browser probe of the line review's AI runs on stand-beta, run after code-review.mjs: the AI review dialog and its
// picker, a run started (from the dialog, or by @reviewer when the stand's providers list no models), its thread
// playing the agent through `bb git-dashboard review comment`, the comment shown signed, Close taking the run's
// rights, Explain and Fix in a new thread offered. Last line is PASS or FAIL.
// Usage: node code-review-runs.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, tools, chrome, out] = process.argv.slice(2);
const stand = process.env.STAND;
const facts = Object.fromEntries(readFileSync(join(stand, "facts.env"), "utf8").trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
const bb = (args, threadId) => execFileSync("node", [join(facts.BB_APP, "dist/bb.js"), ...args], {encoding: "utf8", env: {HOME: join(stand, "home"), PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR ?? "/tmp", BB_TELEMETRY: "false", BB_DATA_DIR: join(stand, "data"), BB_SERVER_URL: url.replace(/\/$/, ""),
  BB_HOST_DAEMON_PORT: facts.DAEMON_PORT, ...(threadId ? {BB_THREAD_ID: threadId} : {})}});
const refusal = (args, threadId) => { try { bb(args, threadId); return ""; } catch (error) { return String(error.stderr ?? error.message); } };
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const until = async (condition, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 300)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  writeFileSync(join(stand, "home/projects/beta/README.md"), "a\nfirst run line\nsecond run line\n");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  const openReview = async () => {
    await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
    await page.locator(".git-projects-table").getByRole("button", { name: "beta", exact: true }).first().click({ timeout: 30000 });
    await page.getByRole("tablist", { name: "Project sections" }).getByRole("tab", { name: "Review" }).click();
    const review = page.getByRole("region", { name: "Review" });
    await visible(review.getByRole("region", { name: "README.md" }));
    return review;
  };
  let review = await openReview();

  await review.getByRole("button", { name: "AI review" }).click();
  const dialog = review.getByRole("group", { name: "AI review" });
  check("AI review offers review or summary with focuses", await visible(dialog.getByRole("button", { name: "Summarize" }))
    && await dialog.getByRole("group", { name: /Focus/ }).getByRole("button").count() === 6);
  await until(async () => await dialog.getByText("Loading the providers…").count() === 0);
  const start = dialog.getByRole("button", { name: "Start review" });
  const pickerReady = await start.isEnabled();
  const warning = (await dialog.locator(".git-warning, .git-error").allInnerTexts()).join(" ");
  check("the picker loads a model, or says why it cannot", pickerReady || warning.length > 0, pickerReady ? "model" : warning.slice(0, 160));
  await page.screenshot({ path: out + "/code-review-ai-dialog.png", fullPage: true });
  if (pickerReady) {
    await dialog.getByRole("button", { name: "Security" }).click();
    await start.click();
    check("starting the review reports it", await visible(review.getByText(/AI review started|Could not start the thread/)));
  } else {
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await review.getByRole("button", { name: "Comment on line 2" }).click();
    await review.getByLabel("Line comment").fill("@reviewer is this line right?");
    await review.getByRole("button", { name: "Comment", exact: true }).click();
  }
  const runs = review.getByRole("region", { name: "AI runs" });
  check("the run is listed in the review", await until(async () => {
    if (await runs.getByText(/^AI review/).count() > 0) return true;
    await review.getByRole("button", { name: "Reload" }).click().catch(() => {});
    return false;
  }, 30000));
  const row = runs.locator(".git-code-review-run").first();
  const status = await row.locator(".git-review-tag").innerText().catch(() => "");
  check("the run has a thread and a state", await visible(row.getByRole("button", { name: "Open thread" })), status);
  await page.screenshot({ path: out + "/code-review-runs.png", fullPage: true });

  await row.getByRole("button", { name: "Open thread" }).click();
  await until(async () => /thr_[A-Za-z0-9_-]+/.test(page.url()));
  const runThread = page.url().match(/thr_[A-Za-z0-9_-]+/)?.[0];
  check("Open thread goes to the run's thread", Boolean(runThread), page.url());

  const header = page.getByRole("button", { name: "Review this thread's changes" });
  if (await visible(header, 10000)) {
    await header.click();
    check("the thread header's Review button opens the thread's Review tab", await visible(page.getByRole("region", { name: "Review" }).getByLabel("What to review")));
  } else check("the thread header's Review button is there", false, "not found");
  const listed = JSON.parse(bb(["git-dashboard", "review", "list", "--all", "--json"], runThread));
  check("the review run sees the threads of its review", Array.isArray(listed) && listed.length >= 1, listed.length);
  const said = bb(["git-dashboard", "review", "comment", "README.md", "--line", "2", "--end-line", "3", "--severity", "nit", "Probe", "comment", "from", "the", "run."], runThread);
  check("the run comments on lines the diff shows", /^Added comment thread [0-9a-f]{12} on README\.md:2-3/.test(said), said.trim());
  const outside = refusal(["git-dashboard", "review", "comment", "README.md", "--line", "40", "x"], runThread);
  check("a comment off the diff is refused with the lines it shows", /LINE_NOT_IN_DIFF: .*Lines shown there: 1-3/.test(outside), outside.slice(0, 200));

  review = await openReview();
  const agentThread = review.getByRole("article", { name: /Comment thread on README\.md:2-3/ });
  check("the owner sees the run's comment, signed by the agent", await visible(agentThread.getByText("Probe comment from the run.")) && await visible(agentThread.getByText("Nit")));
  await review.getByRole("region", { name: "AI runs" }).locator(".git-code-review-run").first().getByRole("button", { name: "Close" }).click();
  check("Close drops the run from the list", await until(async () => await review.getByRole("region", { name: "AI runs" }).count() === 0));
  const closed = refusal(["git-dashboard", "review", "comment", "--general", "Late"], runThread);
  check("a closed run's thread loses its rights", /not_a_review_run|NOT_A_REVIEW_RUN/i.test(closed), closed.slice(0, 120));

  await review.getByRole("region", { name: "README.md" }).getByRole("button", { name: "Explain" }).click();
  check("Explain starts a run for the file", await visible(review.getByText(/Explanation started|Could not start the thread/)) &&
    await visible(review.getByRole("region", { name: "AI runs" }).getByText("Explain · README.md")));
  await review.getByRole("button", { name: /Send to agent/ }).click();
  const send = review.getByRole("group", { name: "Send to agent" });
  await send.getByLabel("Fix in a new thread").check();
  check("Fix in a new thread offers who runs it", await visible(send.getByText(/Runs in a new thread in the working copy.s project/)));
  await page.screenshot({ path: out + "/code-review-fix.png", fullPage: true });
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 400));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
