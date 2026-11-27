// Browser probe of a self-managed GitLab stand-in on the same host name as the Gitea one, told apart by port:
// automatic connection, pipelines and filters, a failed job's trace opened at its own error (not the runner's
// closing line), retry of failed jobs and Run pipeline with a variable through the confirmation dialog (checked in
// the stand-in's write log), issues, and variables listed without values. Last line is PASS or FAIL.
// Usage: node gitlab.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <repo>   (env STAND = stand directory)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const writes = () => readFileSync(process.env.STAND + "/forge/gitlab-writes.log", "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
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
  await page.getByRole("button", { name: "+ Подключить копию" }).click({ timeout: 30000 });
  const select = page.locator(".git-add-copy select").first();
  const value = await select.locator("option").evaluateAll(options => options.find(option => option.textContent.trim().endsWith("/gamma"))?.value ?? "");
  await select.selectOption(value);
  await page.getByRole("button", { name: "Подключить и показать worktree" }).click();
  const entry = page.locator("button.git-table-entry", { hasText: "gamma" }).first();
  check("copy attached", await visible(entry));
  await entry.click();
  const sections = page.getByRole("navigation", { name: "Repository sections" });
  await sections.getByRole("button", { name: "Actions" }).click();
  check("GitLab and its account detected by port and connected", await visible(page.getByText(/GitLab · localhost\/stand\/gamma · stand \(stand\)/)));
  const failed = page.getByRole("button", { name: "Pipeline #2" });
  const listed = await visible(failed);
  if (!listed) { await page.screenshot({ path: out + "/gitlab-no-runs.png", fullPage: true }); console.log((await page.locator("body").innerText()).slice(0, 1500)); }
  check("pipelines listed with their state", listed && await visible(page.locator(".git-state[data-state=running]")) &&
    await visible(page.getByRole("button", { name: "Pipeline #1" })));
  await page.getByRole("group", { name: "Runs to show" }).getByRole("button", { name: "Active" }).click();
  await page.waitForTimeout(800);
  check("Active shows only the running pipeline", await page.getByRole("button", { name: "Pipeline #3" }).count() === 1 && await failed.count() === 0);
  await page.getByRole("group", { name: "Runs to show" }).getByRole("button", { name: "Failed" }).click();
  await page.waitForTimeout(800);
  check("Failed shows only the failed pipeline", await failed.count() === 1 && await page.getByRole("button", { name: "Pipeline #3" }).count() === 0);
  await page.screenshot({ path: out + "/gitlab-runs.png", fullPage: true });

  await failed.click();
  check("jobs are named by stage", await visible(page.getByText("test · unit")) && await visible(page.getByText("build · build")));
  const marked = page.locator(".git-ci-line[data-error]");
  check("trace opens at the job's own error, not the runner's closing line", await visible(marked) && /^ERROR: src\/greeting\.txt:2/.test(await marked.evaluate(line => [...line.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(""))));
  check("error line number is stated", await visible(page.getByText("Opened at the error on line 63.")));
  const logText = await page.locator(".git-ci-log, pre").first().innerText().catch(() => "");
  check("section markers and colours are removed", !/section_(start|end)|\u001b|\[0K/.test(logText));
  await page.screenshot({ path: out + "/gitlab-run.png", fullPage: true });

  await page.getByRole("button", { name: "Re-run failed jobs" }).click();
  const dialog = page.getByRole("dialog");
  check("retry asks for confirmation first", await visible(dialog.getByText("Re-run failed jobs of Pipeline #2")) && writes().length === 0);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await page.waitForTimeout(800);
  check("retry reached GitLab once", JSON.stringify(writes().map(write => write.path)) === JSON.stringify(["/api/v4/projects/7/pipelines/102/retry"]), writes());

  await page.getByRole("button", { name: "All runs" }).click();
  await page.getByRole("button", { name: "Run workflow" }).first().click();
  const form = page.getByRole("form", { name: "Run workflow" });
  const environment = form.getByRole("combobox").nth(1);
  check("Run pipeline offers the described variable and its options", await visible(form.getByText("DEPLOY_ENV")) &&
    (await environment.locator("option").allInnerTexts()).join(",") === "staging,production" && await form.getByText("INTERNAL").count() === 0);
  await environment.selectOption("production");
  await form.getByRole("button", { name: "Run workflow" }).click();
  check("Run pipeline asks for confirmation with its variable", await visible(page.getByRole("dialog").getByText("DEPLOY_ENV = production")));
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.waitForTimeout(800);
  const started = writes().find(write => write.path === "/api/v4/projects/7/pipeline");
  check("Run pipeline reached GitLab with its variable", started?.body?.ref === "main" &&
    JSON.stringify(started.body.variables) === JSON.stringify([{key: "DEPLOY_ENV", value: "production"}]), started);

  await sections.getByRole("button", { name: "Issues" }).click();
  check("issues listed", await visible(page.getByText("#4 Greeting is wrong")));
  await sections.getByRole("button", { name: "Variables" }).click();
  check("variables listed by name with flags", await visible(page.getByText("DEPLOY_TOKEN")) && await visible(page.getByText("protected, masked")) &&
    await visible(page.getByRole("columnheader", { name: "Settings" })) && await page.getByRole("columnheader", { name: "Value" }).count() === 0);
  check("variable values are not shown", await visible(page.getByText("Values are not shown.")) && !(await page.content()).includes("stand-variable-value"));
  await page.screenshot({ path: out + "/gitlab-variables.png", fullPage: true });

  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
