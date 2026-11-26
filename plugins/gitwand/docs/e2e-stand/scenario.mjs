// Live scenario on the isolated BB stand: the thread's GitWand tab opens the
// thread's repository; stage, commit (checked on disk); integrated terminal
// (checked through a file it writes); sidebar page; settings section.
// Usage: node scenario.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <thread> <repo>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, toolsDir, chrome, out, project, thread, repo] = process.argv.slice(2);
const { chromium } = createRequire(toolsDir + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(`${new URL(m.location().url || url).host}: ${m.text().slice(0, 160)}`);
});
const report = {};
const failures = [];
const check = (name, ok, detail) => {
  report[name] = { ok, ...(detail === undefined ? {} : { detail }) };
  if (!ok) failures.push(name);
};
const gitLog = () => execFileSync("git", ["-C", repo, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
const sleep = (ms) => page.waitForTimeout(ms);

// 1. Thread → header action → GitWand tab.
await page.goto(`${url}projects/${project}/threads/${thread}`, { waitUntil: "load" });
await sleep(3000);
await page.getByRole("button", { name: "GitWand", exact: true }).last().click();
const iframe = page.locator('iframe[title="GitWand"]');
await iframe.waitFor({ timeout: 20000 }).catch(() => {});
check("tab: iframe present", (await iframe.count()) === 1);
const src = (await iframe.count()) ? await iframe.getAttribute("src") : null;
check("tab: iframe on the sibling origin with the thread's repo", src === `${url.replace("127.0.0.1", "localhost")}api/v1/plugins/makosh-gitwand/http/ui/index.html?repo=${encodeURIComponent(repo)}`, src);
const frame = page.frameLocator('iframe[title="GitWand"]');
const fr = () => page.frames().find((f) => f.url().includes("/http/ui/index.html"));
await frame.locator("body").getByText("modified").first().waitFor({ timeout: 30000 }).catch(() => {});
check("tab: desktop mode (shim installed)", (await fr()?.evaluate(() => !!window.__TAURI_INTERNALS__)) === true);
await page.screenshot({ path: `${out}/1-tab.png` });

// 2. Commit view shows the modified file.
await frame.getByRole("button", { name: "Commit", exact: true }).first().click().catch((e) => errors.push("click Commit: " + e.message.slice(0, 100)));
await frame.getByText("changed.txt").first().waitFor({ timeout: 15000 }).catch(() => {});
check("status: changed.txt listed", (await frame.getByText("changed.txt").count()) > 0);

// 3. Widen the panel (GitWand's own dock covers its commit buttons below ~600 px),
//    then stage all, write a summary, commit; the commit is on disk.
const box = await iframe.boundingBox();
report.panelWidthBefore = Math.round(box?.width ?? 0);
await page.mouse.move(box.x - 1, 450);
await page.mouse.down();
await page.mouse.move(380, 450, { steps: 12 });
await page.mouse.up();
await sleep(800);
report.panelWidthAfter = Math.round((await iframe.boundingBox())?.width ?? 0);
const summary = `stand commit from GitWand ${Date.now()}`;
// The "+" of the Changes section stages its files (the dock covers "Stage all" here).
await frame.locator(".section-header .action-group-btn", { hasText: "+" }).first().click().catch((e) => errors.push("stage: " + e.message.slice(0, 100)));
for (let i = 0; i < 20 && execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim() === ""; i++) await sleep(250);
await sleep(1500);
await frame.getByPlaceholder("Summary (required)").fill(summary).catch((e) => errors.push("summary: " + e.message.slice(0, 100)));
await sleep(500);
await page.screenshot({ path: `${out}/2-staged.png` });
check("stage: git index has changed.txt", execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim() === "changed.txt");
await frame.getByPlaceholder("Summary (required)").press("Control+Enter").catch((e) => errors.push("commit: " + e.message.slice(0, 100)));
for (let i = 0; i < 40 && gitLog() !== summary; i++) await sleep(250);
check("commit: git log -1 on disk shows the summary", gitLog() === summary, gitLog());
check("commit: worktree clean afterwards", execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).trim() === "");
await page.screenshot({ path: `${out}/3-committed.png` });

// 4. Integrated terminal writes a file in the repository.
const proof = `${repo}/term-proof.txt`;
// GitWand remembers whether its terminal panel was open; open it only if it is not.
const xterm = frame.locator(".tp").first(); // GitWand's own DomTerminal panel
if (!(await xterm.isVisible().catch(() => false))) {
  await frame.getByRole("button", { name: "Terminal", exact: true }).click().catch((e) => errors.push("terminal button: " + e.message.slice(0, 100)));
}
await xterm.waitFor({ state: "visible", timeout: 15000 }).catch((e) => errors.push("xterm: " + e.message.slice(0, 100)));
await sleep(1500);
const tb = await xterm.boundingBox();
await xterm.click({ position: { x: Math.round((tb?.width ?? 200) / 2), y: Math.round((tb?.height ?? 200) * 0.65) } }).catch((e) => errors.push("focus terminal: " + e.message.slice(0, 100)));
await page.keyboard.type("echo gw-$((40+2))-ok > term-proof.txt\n");
for (let i = 0; i < 40 && !existsSync(proof); i++) await sleep(250);
check("terminal: command ran in the repository", existsSync(proof) && readFileSync(proof, "utf8").trim() === "gw-42-ok", existsSync(proof) ? readFileSync(proof, "utf8").trim() : "no file");
await page.screenshot({ path: `${out}/4-terminal.png` });

// 5. Sidebar page.
await page.goto(`${url}plugins/makosh-gitwand/gitwand`, { waitUntil: "load" });
await page.locator('iframe[title="GitWand"]').waitFor({ timeout: 20000 }).catch(() => {});
await sleep(3000);
check("page: GitWand in the sidebar page", (await fr()?.evaluate(() => !!window.__TAURI_INTERNALS__)) === true);
await page.screenshot({ path: `${out}/5-page.png` });

// 6. Settings section.
await page.goto(`${url}settings/plugins/makosh-gitwand`, { waitUntil: "load" });
await page.getByText(/3\.14\.0\+bb\d+/).first().waitFor({ timeout: 15000 }).catch(() => {});
const settingsText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const m = /Рантайм (.{0,80})/.exec(settingsText);
check("settings: runtime and backend shown", /3\.14\.0\+bb\d+ \(каталог разработки\)/.test(settingsText) && /Бэкенд (работает|не запущен)/.test(settingsText), m?.[0]);
await page.screenshot({ path: `${out}/6-settings.png`, fullPage: true });

check("no page errors", errors.length === 0, errors);
report.consoleErrors = consoleErrors.slice(0, 20);
console.log(JSON.stringify(report, null, 1));
await browser.close();
console.log(failures.length ? `SCENARIO FAIL: ${failures.join("; ")}` : "SCENARIO PASS");
process.exit(failures.length ? 1 : 0);
