// Browser probe of the CI/CD section against the stand's HTTPS Gitea stand-in: automatic connection, runs and
// filters, the failed job's log opened at its error line, re-run failed jobs and a manual run with inputs through
// the confirmation dialog (checked in the forge's write log), Ask agent. Last line is PASS or FAIL.
// Usage: node ci.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <repo>   (env STAND = stand directory)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const writes = () => readFileSync(process.env.STAND + "/forge/writes.log", "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
// Waits for a condition instead of a fixed pause: a loaded machine answers later.
const until = async (condition, timeout = 10000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 250)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  await page.getByRole("button", { name: "+ Подключить копию" }).click({ timeout: 30000 });
  const select = page.locator(".git-add-copy select").first();
  const value = await select.locator("option").evaluateAll(options => options.find(option => option.textContent.trim().endsWith("/beta"))?.value ?? "");
  await select.selectOption(value);
  await page.getByRole("button", { name: "Подключить и показать worktree" }).click();
  const entry = page.locator("button.git-table-entry", { hasText: "beta" }).first();
  check("copy attached", await visible(entry));
  await entry.click();
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("button", { name: "Actions" }).click();
  check("Gitea and its account detected and connected", await visible(page.getByText(/Gitea · localhost\/stand\/beta · stand \(stand\)/)));
  const failedRun = page.getByRole("button", { name: "CI #2" });
  check("runs listed with their state", await visible(failedRun) && await visible(page.locator(".git-state[data-state=success]")));
  const tiles = page.getByRole("definition");
  check("tiles sum up running, queued, failed and the success rate", await visible(page.locator(".git-ci-tiles")) &&
    JSON.stringify(await page.locator(".git-ci-tile dt").allInnerTexts()) === JSON.stringify(["Running", "Queued", "Failed", "Success rate"]) && await tiles.count() === 4);
  check("runs show their duration", await page.locator("thead th", { hasText: "Duration" }).count() === 1);
  await page.getByRole("group", { name: "Runs to show" }).getByRole("button", { name: "Failed" }).click();
  await until(async () => await page.getByRole("button", { name: "CI #1" }).count() === 0);
  check("failed filter shows only the failed run", await page.getByRole("button", { name: "CI #1" }).count() === 0 && await failedRun.count() === 1);
  await page.screenshot({ path: out + "/ci-runs.png", fullPage: true });

  await failedRun.click();
  const marked = page.locator(".git-ci-line[data-error]");
  check("failed job's log opens at the error line", await visible(marked) && /##\[error\]src\/greeting\.txt:2/.test(await marked.innerText()));
  check("error line number is stated", await visible(page.getByText("Opened at the error on line 91.")));
  const inView = await marked.evaluate(line => { const pane = line.closest("pre").getBoundingClientRect(); const box = line.getBoundingClientRect(); return box.top >= pane.top && box.bottom <= pane.bottom; });
  check("error line is scrolled into view", inView);
  check("only the log scrolled, not the page", await page.evaluate(() => [document.scrollingElement.scrollTop, ...[...document.querySelectorAll(".git-ws")].map(element => element.scrollTop)].every(top => top === 0)));
  const [first, last] = await page.locator(".git-ci-jobs > li").evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
  check("jobs are listed together at the top", last - first < 60, last - first);
  await page.screenshot({ path: out + "/ci-run.png", fullPage: true });
  const filter = page.getByRole("searchbox", { name: "Filter log lines" });
  await filter.fill("greeting");
  check("the log filter keeps matching lines and counts them", await visible(page.getByText(/^\d+ of \d+ lines$/)) &&
    (await page.locator(".git-ci-log .git-ci-line").allInnerTexts()).every(line => line.includes("greeting")));
  await filter.fill("");
  await page.getByLabel("Follow the end").check();
  check("Follow the end scrolls the log to its end", await until(() => page.locator(".git-ci-log").evaluate(pane => pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2)));
  await page.getByLabel("Follow the end").uncheck();
  await page.getByRole("button", { name: "Copy log" }).click();
  check("Copy log reports its outcome", await visible(page.getByText(/^(Log copied\.|The browser did not allow copying\.)$/)));
  check("run has Copy link and Run workflow with inputs", await page.getByRole("button", { name: "Copy link" }).count() === 1 &&
    await page.getByRole("button", { name: "Run workflow with inputs…" }).count() === 1);
  check("a failed run offers Ask agent with another model", await page.getByRole("button", { name: "Ask agent with another model…" }).count() === 1);

  await page.getByRole("button", { name: "Re-run failed jobs" }).click();
  const dialog = page.getByRole("dialog");
  check("re-run asks for confirmation first", await visible(dialog.getByText("Re-run failed jobs of CI #2")) && writes().length === 0);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await until(() => writes().length > 0);
  check("re-run reached the forge once", JSON.stringify(writes().map(write => write.path)) === JSON.stringify(["/api/v1/repos/stand/beta/actions/runs/2/rerun-failed-jobs"]), writes());

  await page.getByRole("button", { name: "Ask agent", exact: true }).click();
  check("Ask agent opens an investigation thread", await visible(page.getByText(/An agent is investigating this run|already being investigated/)));

  await page.getByRole("button", { name: "Send to threads" }).click();
  check("Send to threads takes a message and the log excerpt switch", await visible(page.getByLabel("Add a message (optional)")) &&
    await page.getByLabel("Include log excerpts of failed jobs").isChecked());
  await page.getByRole("button", { name: "Send to threads" }).click();
  await page.getByRole("button", { name: "All runs" }).click();
  await page.getByRole("button", { name: "Run workflow", exact: true }).first().click();
  const form = page.getByRole("form", { name: "Run workflow" });
  const outcome = form.getByRole("combobox").nth(1);
  check("dispatch form offers the declared choice", await visible(form.getByText("outcome")) && (await outcome.locator("option").allInnerTexts()).join(",") === "success,failure");
  await outcome.selectOption("failure");
  await form.getByRole("button", { name: "Run workflow" }).click();
  check("manual run asks for confirmation with its inputs", await visible(page.getByRole("dialog").getByText("outcome = failure")));
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await until(() => writes().some(write => write.path.endsWith("/dispatches")));
  const dispatch = writes().find(write => write.path.endsWith("/dispatches"));
  check("manual run reached the forge with its inputs", dispatch?.path === "/api/v1/repos/stand/beta/actions/workflows/ci.yml/dispatches" &&
    dispatch.body?.ref === "main" && JSON.stringify(dispatch.body?.inputs) === JSON.stringify({outcome: "failure"}), dispatch);

  await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: /^CI\/CD\b/ }).click();
  check("CI/CD overview lists runs across repositories with tiles", await visible(page.getByRole("heading", { name: "CI/CD" })) &&
    await visible(page.getByRole("combobox", { name: "Repository" })) && await visible(page.locator(".git-ci-tiles")) &&
    await visible(page.locator("td", { hasText: "stand/beta" })));
  await page.screenshot({ path: out + "/ci-overview.png", fullPage: true });
  await page.locator("button.git-table-entry", { hasText: "CI #2" }).first().click();
  check("an overview row opens its repository's CI/CD", await visible(page.getByRole("button", { name: "CI #2" })));
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  await page.getByRole("button", { name: "All runs" }).click().catch(() => {});
  const badge = page.locator(".git-ci .git-state").first();
  await badge.waitFor({ timeout: 10000 }).catch(() => {});
  const lineHeight = await badge.evaluate(element => { const style = getComputedStyle(element); return element.getBoundingClientRect().height <= parseFloat(style.fontSize) * 1.8; }).catch(() => false);
  check("run status stays on one line at 768 px", lineHeight);
  await page.screenshot({ path: out + "/ci-768.png", fullPage: true });
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
