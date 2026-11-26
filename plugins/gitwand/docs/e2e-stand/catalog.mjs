// The Repositories dialog on the isolated stand, with fake-forges/ standing in
// for gh and glab (run.sh with STAND_BIN=<this dir>/fake-forges):
// the + menu item, local and remote rows, lazy status, search, clone with the
// URL filled in, Pull confirmation, Fetch, Pull requests, Refresh, no token in
// the page, opening a row as a tab, a narrow window and the start screen.
// Usage: node catalog.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <thread> <stand>
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, toolsDir, chrome, out, project, thread, stand] = process.argv.slice(2);
const { chromium } = createRequire(toolsDir + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const invokeBodies = [];
page.on("response", async (r) => {
  if (r.url().includes("/gw/invoke")) invokeBodies.push(await r.text().catch(() => ""));
});
const report = {};
const failures = [];
const check = (name, ok, detail) => {
  report[name] = { ok, ...(detail === undefined ? {} : { detail }) };
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => page.waitForTimeout(ms);
const log = () => (existsSync(`${stand}/forge-calls.log`) ? readFileSync(`${stand}/forge-calls.log`, "utf8").trim().split("\n").filter(Boolean) : []);
const count = (lines, line) => lines.filter((l) => l === line).length;

const before = log();
await page.goto(`${url}projects/${project}/threads/${thread}`, { waitUntil: "load" });
await sleep(3000);
await page.getByRole("button", { name: "GitWand", exact: true }).last().click();
await page.locator('iframe[title="GitWand"]').waitFor({ timeout: 20000 });
const frame = page.frameLocator('iframe[title="GitWand"]');
await frame.locator(".repo-tab-new").waitFor({ timeout: 30000 });
await sleep(1500);

const names = () => frame.locator(".rc-row .rc-row-name").allTextContents();
async function openDialog() {
  await frame.locator(".repo-tab-new").click();
  await frame.getByRole("menuitem", { name: "Browse repositories…" }).waitFor({ timeout: 5000 });
}

// 1. The + menu offers the dialog.
await openDialog();
check("menu: + offers Browse repositories…", (await frame.getByRole("menuitem", { name: "Browse repositories…" }).count()) === 1);
await page.screenshot({ path: `${out}/c1-plus-menu.png` });
await frame.getByRole("menuitem", { name: "Browse repositories…" }).click();
await frame.locator(".rc-row").first().waitFor({ timeout: 30000 });
await sleep(1500);

// 2. Local first, then remote repositories without a clone; counts per scope.
check("list: local then uncloned remote rows", JSON.stringify(await names()) === JSON.stringify(["alpha", "beta", "scratch", "stand-group/pipeline", "stand-org/shared", "stand-owner/notes", "stand-owner/old-site", "stand-work/report"]), await names());
const scopeText = (await frame.locator(".rc-scope").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim());
check("list: scope counts", JSON.stringify(scopeText) === JSON.stringify(["All 8", "This computer 3", "Remote 6"]), scopeText);
// The first catalog ever lists each source once; with a cache, opening lists nothing.
const opened = log().slice(before.length);
const listedOnce = count(opened, "gh api stand-owner") === 1 && count(opened, "gh api stand-work") === 1 && count(opened, "glab api gitlab.com") === 1;
check("forges: listed once on the first open, not at all from the cache", before.length === 0 ? listedOnce : opened.length === 0, { before: before.length, opened });
check("forges: no listing without its own token", !log().some((x) => x.includes("leaked")), log());
check("list: no source errors", (await frame.locator(".rc-notices").count()) === 0, await frame.locator(".rc-notices").allTextContents());

// 3. Status of the rows in view, loaded without asking.
await frame.locator(".rc-row-state").first().waitFor({ timeout: 15000 }).catch(() => {});
const states = await frame.locator(".rc-row-state").allTextContents();
check("status: loaded for the visible local rows", states.length === 3, states);
await page.screenshot({ path: `${out}/c2-dialog.png` });

// 4. Search; one repository seen by two accounts is one row.
await frame.locator(".rc-search").fill("shared");
await sleep(300);
const detail = await frame.locator(".rc-row .rc-row-detail").allTextContents();
check("search: one row for shared, both accounts named", JSON.stringify(await names()) === '["stand-org/shared"]' && detail[0] === "GitHub · stand-owner, stand-work", { names: await names(), detail });
await page.screenshot({ path: `${out}/c3-search.png` });
await frame.locator(".rc-search").fill("");

// 5. Remote scope: the cloned repository is marked and opens its clone.
await frame.locator(".rc-scope", { hasText: "Remote" }).click();
await sleep(300);
const alpha = frame.locator(".rc-item", { has: frame.locator(".rc-row-name", { hasText: /^stand-owner\/alpha$/ }) });
check("remote: alpha marked Cloned with Open", (await alpha.locator(".rc-badge--accent").textContent()) === "Cloned" && (await alpha.locator(".rc-row-action").textContent()) === "Open");
await page.screenshot({ path: `${out}/c4-remote.png` });

// 6. An uncloned repository goes to CloneModal with its URL; the folder stays empty.
await frame.locator(".rc-row", { hasText: "stand-work/report" }).click();
await frame.locator("#cm-url").waitFor({ timeout: 5000 });
const cloneUrl = await frame.locator("#cm-url").inputValue();
const parent = await frame.locator("#cm-parent").inputValue();
check("clone: CloneModal with the https URL of the https account, folder asked", cloneUrl === "https://github.com/stand-work/report.git" && parent === "", { cloneUrl, parent });
await page.screenshot({ path: `${out}/c5-clone.png` });
await frame.getByRole("button", { name: "Cancel" }).click();
await sleep(300);

// 7. Pull asks first and lists the selection; Fetch runs on it.
await openDialog();
await frame.getByRole("menuitem", { name: "Browse repositories…" }).click();
await frame.locator(".rc-row").first().waitFor({ timeout: 15000 });
check("forges: reopening the dialog lists nothing", log().length === before.length + opened.length, log());
await frame.getByLabel("Select beta").check();
await frame.locator(".rc-bulk").getByRole("button", { name: "Pull…" }).click();
await frame.locator(".rc-confirm-list").waitFor({ timeout: 5000 });
const confirmList = (await frame.locator(".rc-confirm-list li").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim());
check("pull: confirmation lists only the selection", confirmList.length === 1 && confirmList[0].startsWith("beta "), confirmList);
await page.screenshot({ path: `${out}/c6-pull-confirm.png` });
await frame.locator(".bm-btn--ghost", { hasText: "Cancel" }).last().click();
await sleep(300);
await frame.locator(".rc-bulk").getByRole("button", { name: "Fetch", exact: true }).click();
await sleep(3000);
check("fetch: finished without an error", (await frame.locator(".rc-error").count()) === 0 && (await frame.locator(".rc-progress").count()) === 0, await frame.locator(".rc-error").allTextContents());

// 8. Pull requests for the selection.
await frame.getByLabel("Select alpha").check();
await frame.locator(".rc-bulk").getByRole("button", { name: "Pull requests" }).click();
await frame.locator(".rc-prs").first().waitFor({ timeout: 20000 }).catch(() => {});
const prsText = await frame.locator(".rc-prs").allTextContents();
check("prs: a result line under each selected row", prsText.length === 2, prsText.map((s) => s.trim().slice(0, 120)));
await page.screenshot({ path: `${out}/c7-prs.png` });

// 9. Refresh lists every forge again.
const beforeRefresh = log().length;
await frame.locator(".rc-status").getByRole("button", { name: "Refresh", exact: true }).click();
await frame.locator(".rc-status").getByRole("button", { name: "Refresh", exact: true }).waitFor({ timeout: 30000 });
await sleep(1000);
const refreshed = log().slice(beforeRefresh);
check("refresh: each source listed once more", refreshed.length === 3 && count(refreshed, "gh api stand-owner") === 1 && count(refreshed, "gh api stand-work") === 1 && count(refreshed, "glab api gitlab.com") === 1, refreshed);

// 10. No token reaches the page.
const html = await frame.locator("body").innerHTML();
check("tokens: none in the page or the relay answers", !html.includes("fake-token") && !invokeBodies.some((b) => b.includes("fake-token")), { answers: invokeBodies.length });

// 11. A narrow window keeps the dialog usable.
await page.setViewportSize({ width: 900, height: 700 });
await sleep(800);
const box = await frame.locator(".rc-body").boundingBox();
const tab = await page.locator('iframe[title="GitWand"]').boundingBox();
check("narrow: dialog stays inside the GitWand tab", box !== null && tab !== null && box.x >= tab.x && box.x + box.width <= tab.x + tab.width + 1, { box, tab });
await page.screenshot({ path: `${out}/c8-narrow.png` });
await page.setViewportSize({ width: 1440, height: 900 });

// 12. A local row opens as a tab.
await frame.locator(".rc-scope", { hasText: "All" }).click();
await frame.locator(".rc-row", { hasText: "beta" }).first().click();
await sleep(2500);
const tabs = await page.frames().find((f) => f.url().includes("/http/ui/index.html"))?.evaluate(() => JSON.parse(localStorage.getItem("gitwand-open-tabs") ?? "null"));
check("open: beta is the active tab", typeof tabs?.activePath === "string" && tabs.activePath.endsWith("/projects/group/beta"), tabs);
await page.screenshot({ path: `${out}/c9-opened.png` });

// 13. The start screen offers the dialog too.
const fr = page.frames().find((f) => f.url().includes("/http/ui/index.html"));
await fr.evaluate(() => {
  localStorage.setItem("gitwand-open-tabs", JSON.stringify({ paths: [], activePath: null }));
});
await page.goto(`${url}plugins/makosh-gitwand/gitwand`, { waitUntil: "load" });
await page.locator('iframe[title="GitWand"]').waitFor({ timeout: 20000 });
await frame.getByRole("button", { name: "Browse repositories" }).waitFor({ timeout: 20000 }).catch(() => {});
check("start screen: Browse repositories button", (await frame.getByRole("button", { name: "Browse repositories" }).count()) === 1);
await page.screenshot({ path: `${out}/c10-start.png` });

check("no page errors", errors.length === 0, errors);
await browser.close();
console.log(failures.length ? `CATALOG FAIL: ${failures.join("; ")}` : "CATALOG PASS");
process.exit(failures.length ? 1 : 0);
