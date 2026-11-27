// Browser probe of the line review on stand-beta, run after ci.mjs (whose Ask agent leaves a thread working in beta's
// copy): an uncommitted change reviewed in Git → Review, a line comment with a severity, Send to agent into that
// thread, the agent's answer through `bb git-dashboard review` from the thread, and the answer shown as Answered.
// Last line is PASS or FAIL. Usage: node code-review.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND)
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
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const until = async (condition, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 250)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  writeFileSync(join(stand, "home/projects/beta/README.md"), "a\nreviewed line\n");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  await page.locator("button.git-table-entry", { hasText: "beta" }).first().click({ timeout: 30000 });
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("region", { name: "Review" });
  check("the uncommitted change is shown", await visible(review.getByRole("region", { name: "README.md" })) &&
    await visible(review.locator(".git-review-row[data-kind=add]", { hasText: "reviewed line" })));
  await review.getByRole("button", { name: "Comment on line 2" }).click();
  await review.getByLabel("Line comment").fill("Capitalise this line.");
  await review.getByLabel("Severity").selectOption("must-fix");
  await review.getByRole("button", { name: "Comment", exact: true }).click();
  const thread = review.getByRole("article", { name: /Comment thread on README\.md:2/ });
  check("a line comment with its severity appears under its line", await visible(thread) && await visible(thread.getByText("Must fix")));
  await page.screenshot({ path: out + "/code-review-comment.png", fullPage: true });

  await review.getByRole("button", { name: "Send to agent (1)" }).click();
  const form = review.getByRole("group", { name: "Send to agent" });
  const target = form.getByRole("combobox");
  check("the thread working in this copy is offered", await until(async () => (await target.locator("option").count()) > 0));
  const threadId = await target.inputValue();
  await form.getByRole("button", { name: "Send 1" }).click();
  check("sending marks the comment thread sent", await visible(review.getByText("Sent 1 comment thread to the agent.")) && await visible(thread.getByText("Sent")));

  const listed = JSON.parse(bb(["git-dashboard", "review", "list", "--json"], threadId));
  check("the agent's thread lists the comment sent to it", listed.length === 1 && listed[0].comments[0].body === "Capitalise this line.", listed.length);
  const answer = Buffer.from("Done: capitalised it.\n").toString("base64");
  const said = bb(["git-dashboard", "review", "resolve", listed[0].id.slice(0, 6), "--text-base64", answer], threadId);
  check("the agent resolves it from its thread", /^Resolved comment thread/.test(said), said.trim());
  let refused = "";
  try { bb(["git-dashboard", "review", "reply", listed[0].id, "From elsewhere"]); } catch (error) { refused = String(error.stderr ?? error.message); }
  check("an answer from outside the thread is refused", /inside the BB thread|THREAD_REQUIRED|thread_required/i.test(refused), refused.slice(0, 120));
  check("the owner sees the agent's answer and the thread resolved", await until(async () =>
    await thread.getByText("Done: capitalised it.").count() > 0 || await review.getByText("Resolved").count() > 0));
  await review.getByRole("button", { name: "Reload" }).click();
  const resolved = review.getByRole("article", { name: /Comment thread on README\.md:2/ });
  await resolved.getByRole("button", { name: "Show" }).click().catch(() => {});
  check("the answer is signed by the agent and marked answered", await visible(resolved.getByText("Done: capitalised it.")) && await visible(resolved.getByText("Answered")));
  await page.screenshot({ path: out + "/code-review-answered.png", fullPage: true });
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
