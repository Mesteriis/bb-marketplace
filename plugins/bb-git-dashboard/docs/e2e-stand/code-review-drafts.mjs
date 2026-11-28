// Browser probe of agents' draft answers on a pull request's review thread, over the Gitea stand-in, run after
// review.mjs: Fix with agent on the thread, its agent thread answering by the thread's Makosh Git id through
// `bb git-dashboard review reply` (saved as a draft), the draft on the pull request's page, edited, then posted
// through the confirmation dialog to Gitea once. Last line is PASS or FAIL.
// Usage: node code-review-drafts.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, tools, chrome, out] = process.argv.slice(2);
const stand = process.env.STAND;
const facts = Object.fromEntries(readFileSync(join(stand, "facts.env"), "utf8").trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
const bb = (args, threadId) => execFileSync("node", [join(facts.BB_APP, "dist/bb.js"), ...args], {encoding: "utf8", env: {HOME: join(stand, "home"), PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR ?? "/tmp", BB_TELEMETRY: "false", BB_DATA_DIR: join(stand, "data"), BB_SERVER_URL: url.replace(/\/$/, ""),
  BB_HOST_DAEMON_PORT: facts.DAEMON_PORT, ...(threadId ? {BB_THREAD_ID: threadId} : {})}});
const log = () => readFileSync(join(stand, "forge/writes.log"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const until = async (condition, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 300)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  const openPull = async () => {
    await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
    await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: /^My PRs\b/ }).click({ timeout: 30000 });
    await page.locator(".git-inbox-item", { hasText: "Add greeting check" }).locator("a").first().click();
    const pr = page.getByRole("region", { name: "Pull request stand/beta #3" });
    await visible(pr.getByRole("heading", { name: /Add greeting check/ }));
    await pr.getByRole("tablist", { name: "Pull request sections" }).getByRole("tab", { name: /^Comments/ }).click();
    return pr;
  };
  let pr = await openPull();
  const thread = pr.locator(".git-pr-thread", { hasText: "wrold?" });
  await thread.getByRole("button", { name: "Fix with agent" }).click();
  const reached = await until(async () => /thr_[A-Za-z0-9_-]+/.test(page.url()));
  check("Fix with agent opens the agent's thread", reached, reached ? undefined : (await pr.locator(".git-muted[role=status], [role=alert], .git-review-notice").allInnerTexts()).join(" | ").slice(0, 400));
  const agentThread = page.url().match(/thr_[A-Za-z0-9_-]+/)?.[0];

  const listed = JSON.parse(bb(["git-dashboard", "review", "list", "--json"], agentThread));
  const mirrored = listed.find(item => item.comments.some(comment => comment.body === "wrold?"));
  check("the agent's thread lists the pull request's thread by its Makosh Git id", Boolean(mirrored), listed.length);
  const said = bb(["git-dashboard", "review", "reply", mirrored.id, "Fixed", "the", "typo."], agentThread);
  check("its answer is kept as a draft for the owner", /^Saved a draft reply in comment thread/.test(said), said.trim());

  pr = await openPull();
  const draft = pr.getByRole("region", { name: /Draft reply by/ }).or(pr.getByLabel(/Draft reply by/));
  check("the draft shows under the thread, not posted", await visible(draft) && await visible(draft.getByText("Fixed the typo.")) && log().every(write => !JSON.stringify(write).includes("Fixed the typo")));
  await draft.getByRole("button", { name: "Edit" }).click();
  await draft.getByLabel("Edit the draft reply").fill("Fixed the typo in line 2.");
  await draft.getByRole("button", { name: "Save" }).click();
  check("the draft can be edited", await visible(draft.getByText("Fixed the typo in line 2.")));
  await draft.getByLabel("Edit the draft reply").waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  await page.mouse.move(0, 0);
  // The button's colours ease in (.12 s) once it appears; read them, and take the shot, after that.
  await page.waitForTimeout(400);
  const send = draft.getByRole("button", { name: "Send", exact: true });
  const look = await send.evaluate(button => {
    const paint = value => { const probe = document.createElement("i"); probe.style.color = value; button.after(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; };
    return {disabled: button.disabled, color: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor,
      foreground: paint("var(--primary-foreground)"), primary: (() => { const probe = document.createElement("i"); probe.style.backgroundColor = "var(--primary)"; button.after(probe);
        const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color; })()};
  });
  check("Send is the main button: enabled, its words in the primary foreground on the primary", !look.disabled && look.color === look.foreground && look.background === look.primary, look);
  await page.screenshot({ path: out + "/pr-comments-draft.png", fullPage: false });
  const before = log().length;
  await draft.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = page.getByRole("dialog");
  check("posting is previewed", await visible(dialog.getByText(/Fixed the typo in line 2\./)));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  check("and reaches Gitea once, the draft gone", await until(async () => log().slice(before).filter(write => JSON.stringify(write).includes("Fixed the typo in line 2.")).length === 1)
    && await until(async () => await pr.getByLabel(/Draft reply by/).count() === 0), log().slice(before));
  await page.screenshot({ path: out + "/code-review-drafts.png", fullPage: false });
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 400));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
