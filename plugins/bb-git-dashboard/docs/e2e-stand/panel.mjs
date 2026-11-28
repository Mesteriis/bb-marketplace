// Browser probe of the Git panel beside a thread (R8), after ci.mjs (whose Ask agent leaves a thread working in
// stand-beta): the thread header's Review button opens the one Git tab on its Review; back gives the summary with its
// parts; CI's Log opens the run in the panel, History its history; the panel's width as BB gives it, and no sideways
// scroll from 420 to 640 px. A new file chosen in the summary opens Code with it shown as a numbered diff, and History
// counts its line. Then a copy pinned from its page and a pull request pinned from its page's ⋯ (twice: one tab), each
// in the side panel of the Git page with Unpin. Shots of each screen in light, dark and Russian go to <outDir>.
// Usage: node panel.mjs <bbUrl> <toolsDir> <chrome> <outDir> (env STAND). Last line is PASS or FAIL.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const [url, tools, chrome, out] = process.argv.slice(2);
const stand = process.env.STAND;
const facts = Object.fromEntries(readFileSync(join(stand, "facts.env"), "utf8").trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
const bb = args => execFileSync("node", [join(facts.BB_APP, "dist/bb.js"), ...args], {encoding: "utf8", env: {HOME: join(stand, "home"), PATH: process.env.PATH,
  BB_SERVER_URL: url.replace(/\/$/, ""), BB_HOST_DAEMON_PORT: facts.DAEMON_PORT, BB_TELEMETRY: "false"}});
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
const words = {
  en: {changes: "Changes", pull: /^Pull request/, review: "Review", history: "History", back: "Back to the summary", log: "Log", openHistory: "Open the history",
    unpin: "Unpin", pin: "Pin", pinnedCopy: "Pinned copy", pinnedPr: "Pinned pull request", head: "Review this thread's changes",
    more: "More pull request actions", pinTab: "Pin as a tab", binary: "binary", uncommitted: "Uncommitted changes"},
  ru: {changes: "Изменения", pull: /^Pull request/, review: "Ревью", history: "История", back: "Назад к сводке", log: "Лог", openHistory: "Открыть историю",
    unpin: "Открепить", pin: "Закрепить", pinnedCopy: "Закреплённая копия", pinnedPr: "Закреплённый PR", head: "Ревью изменений треда",
    more: "Другие действия с PR", pinTab: "Закрепить вкладкой", binary: "двоичный", uncommitted: "Незакоммиченные изменения"},
};
// The widest thing inside the panel against the panel itself: nothing may scroll sideways.
const overflow = (page, selector) => page.evaluate(selector => {
  const root = document.querySelector(selector);
  if (!root) return null;
  return Math.max(0, root.scrollWidth - root.clientWidth);
}, selector);

try {
  // An uncommitted change in stand-beta, so the summary's Changes lists a file and opens the copy's Code.
  appendFileSync(join(stand, "home/projects/beta/panel-note.txt"), "a line for the panel\n");
  const threads = JSON.parse(bb(["thread", "list", "--json"]));
  const items = Array.isArray(threads) ? threads : threads.threads ?? threads.items ?? [];
  const thread = items.find(item => /^CI failed/.test(item.title ?? "")) ?? items[0];
  check("a thread works in stand-beta", Boolean(thread?.id), items.map(item => item.title));
  for (const [theme, language] of [["light", "en"], ["dark", "en"], ["light", "ru"]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    const w = words[language];
    const tag = (language === "ru" ? "ru-" : "") + theme;
    const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: out + "/" + name + "-" + tag + ".png" }); };
    // The language is the plugin's setting: switch it in the Git page's side column first.
    await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
    await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: language.toUpperCase(), exact: true }).click({ timeout: 30000 });
    await page.waitForTimeout(500);

    await page.goto(url + "threads/" + thread.id, { waitUntil: "load" });
    await page.getByRole("button", { name: w.head }).click({ timeout: 30000 });
    const panel = page.locator(".git-panel").first();
    check(tag + ": the header's Review opens the Git tab on its Review", await visible(panel.locator(".git-panel-bar h3", { hasText: w.review }), 30000));
    await panel.getByRole("button", { name: w.back }).click();
    const parts = panel.locator(".git-panel-section-head button");
    check(tag + ": back gives the summary: changes, pull request, CI, review, history", await visible(parts.first(), 20000)
      && (await parts.allInnerTexts()).map(text => text.trim()).join("|").replace(/Pull request[^|]*/, "PR") === [w.changes, "PR", "CI", w.review, w.history].join("|"),
      await parts.allInnerTexts());
    check(tag + ": the head has the copy, Pull and Push", await visible(panel.locator(".git-panel-title h2", { hasText: "beta" })) && await panel.locator(".git-panel-actions .g-btn").count() === 2);
    await page.waitForTimeout(1500);
    if (theme === "light" && language === "en") {
      const width = await panel.evaluate(element => Math.round(element.getBoundingClientRect().width));
      console.log("panel width as BB gives it: " + width);
      check("the panel is as wide as BB gives it, between 420 and 640", width >= 420 && width <= 640, width);
      for (const size of [420, 520, 640]) {
        await panel.evaluate((element, size) => { element.style.width = size + "px"; element.style.maxWidth = size + "px"; }, size);
        await page.waitForTimeout(200);
        check("no sideways scroll at " + size + " px", await overflow(page, ".git-panel") === 0, await overflow(page, ".git-panel"));
        if (size !== 520) await page.screenshot({ path: out + "/thread-panel-" + size + ".png" });
      }
      await panel.evaluate(element => { element.style.width = ""; element.style.maxWidth = ""; });
    }
    await shot("thread-panel");
    // CI's Log opens the run in the panel; back returns.
    const log = panel.getByRole("button", { name: w.log });
    if (await visible(log, 20000)) {
      await log.click();
      check(tag + ": Log opens the run in the panel", await visible(panel.locator(".git-panel-bar h3", { hasText: "CI" })) && await visible(panel.locator(".git-ci-run, .git-ci-log").first(), 30000));
      check(tag + ": the run fits the panel", await overflow(page, ".git-panel") === 0, await overflow(page, ".git-panel"));
      await shot("panel-ci");
      await panel.getByRole("button", { name: w.back }).click();
    } else check(tag + ": CI shows the branch's last run with its Log", false, await panel.locator("#git-panel-ci").locator("..").locator("..").innerText().catch(() => ""));
    // History folds by default; its button opens the history in the panel.
    await panel.getByRole("button", { name: w.history, exact: true }).click();
    await panel.getByRole("button", { name: w.openHistory }).click();
    check(tag + ": History opens the graph in the panel", await visible(panel.locator(".git-history-row").first(), 30000));
    check(tag + ": the history fits the panel", await overflow(page, ".git-panel") === 0, await overflow(page, ".git-panel"));
    await shot("panel-history");
    // The new file among the uncommitted changes: its line counted, not called binary.
    await panel.locator(".git-history-row", { hasText: w.uncommitted }).click({ timeout: 20000 });
    const newRow = panel.locator(".git-history-files li", { hasText: "panel-note.txt" });
    const rowText = await visible(newRow, 20000) ? await newRow.innerText() : "";
    check(tag + ": History counts the new file's line, +1, and does not call it binary", /\+1/.test(rowText) && !rowText.includes(w.binary), rowText);
    const sums = await panel.locator(".git-history-change, .git-history-detail").first().innerText().catch(() => "");
    check(tag + ": the uncommitted changes add up to +1 −0", /\+1\s*−0/.test(sums), sums.slice(0, 200));
    await newRow.click();
    await shot("panel-history-new-file");
    await panel.getByRole("button", { name: w.back }).click();
    await panel.getByRole("button", { name: w.history, exact: true }).click();
    // A file chosen in the summary: Code with that file shown, the new file as a numbered diff, never the raw patch.
    await panel.locator(".git-panel-path", { hasText: "panel-note.txt" }).click({ timeout: 20000 });
    const chosen = panel.locator(".git-changes-name[aria-current]");
    check(tag + ": a file chosen in the summary opens Code with that file shown", await visible(chosen, 20000) && (await chosen.innerText()).includes("panel-note.txt"),
      await chosen.allInnerTexts());
    const added = panel.locator(".git-changes-line[data-type='+']").first();
    const numbered = await visible(added, 20000) ? await added.evaluate(row => [row.children[1]?.textContent ?? "", row.children[2]?.textContent ?? ""]) : null;
    check(tag + ": the new file is a numbered diff: one added line, No. 1", numbered?.[0] === "1" && /a line for the panel/.test(numbered?.[1] ?? ""), numbered);
    check(tag + ": no raw patch is shown", !/diff --git|^@@ -0,0/m.test(await panel.locator(".git-codeview").innerText()));
    const place = panel.locator(".git-code-place");
    const placeTitle = await place.getAttribute("title").catch(() => "");
    check(tag + ": the copy's place names no host id", !/host_/.test((placeTitle ?? "") + (await place.innerText().catch(() => ""))), placeTitle);
    await shot("panel-changes-new-file");
    await panel.getByRole("button", { name: w.back }).click();
    // Changes: the copy's full Code in the panel.
    await panel.locator(".git-panel-section").first().getByRole("button").filter({ hasText: /All changes|Все изменения/ }).click({ timeout: 20000 });
    if (await panel.locator(".git-panel-bar h3", { hasText: w.changes }).count()) {
      check(tag + ": Changes opens the copy's Code in the panel", await visible(panel.locator(".git-codeview")));
      check(tag + ": the copy's Code fits the panel", await overflow(page, ".git-panel") === 0, await overflow(page, ".git-panel"));
      await shot("panel-changes");
      await panel.getByRole("button", { name: w.back }).click();
    } else check(tag + ": Changes lists the uncommitted file and opens the copy's Code", false);

    // A copy pinned from its page stands in the Git page's side panel, saying it is not a thread's, with Unpin.
    await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
    await page.locator(".git-projects-table").getByText("beta", { exact: true }).first().click({ timeout: 30000 });
    // The copy's page: Changes with the new file as a numbered diff, the place named by machine, never its id.
    await page.locator(".git-changes-name", { hasText: "panel-note.txt" }).first().click({ timeout: 30000 });
    const pageAdded = page.locator(".git-codeview .git-changes-line[data-type='+']").first();
    const pageNumbered = await visible(pageAdded, 20000) ? await pageAdded.evaluate(row => [row.children[1]?.textContent ?? "", row.children[2]?.textContent ?? ""]) : null;
    check(tag + ": the copy's Changes shows the new file as a numbered diff", pageNumbered?.[0] === "1" && /a line for the panel/.test(pageNumbered?.[1] ?? ""), pageNumbered);
    check(tag + ": the copy's place names no host id", !/host_/.test(await page.locator(".git-code-place").first().getAttribute("title").catch(() => "") ?? ""));
    await shot("changes-new-file");
    await page.getByRole("button", { name: w.pin, exact: true }).first().click({ timeout: 30000 });
    const pinned = page.locator(".git-panel").filter({ has: page.locator(".git-panel-note", { hasText: w.pinnedCopy }) });
    check(tag + ": a pinned copy is the same panel with its note and Unpin", await visible(pinned, 30000) && await visible(pinned.getByRole("button", { name: w.unpin })));
    await shot("panel-pinned-copy");
    await pinned.getByRole("button", { name: w.unpin }).click();
    check(tag + ": Unpin closes it", await pinned.first().waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false));

    // A pull request pinned from its page's ⋯: its page in the side panel, under the pinned line; pinned again, the same tab.
    await page.goto(url + "plugins/bb-git-dashboard/git/inbox", { waitUntil: "load" });
    const inboxRow = page.locator(".git-inbox-item", { hasText: "Add greeting check" });
    await inboxRow.waitFor({ timeout: 60000 }).catch(() => {});
    await inboxRow.locator("a").first().click({ timeout: 30000 });
    const pinOnce = async () => {
      await page.locator(".git-pr-head").getByRole("button", { name: w.more }).first().click({ timeout: 30000 });
      await page.getByRole("menuitem", { name: w.pinTab }).click({ timeout: 10000 });
    };
    await pinOnce();
    await page.waitForTimeout(800);
    await pinOnce();
    await page.waitForTimeout(800);
    check(tag + ": pinning the same pull request again gives no second tab", await page.getByText("beta #3", { exact: true }).count() === 1,
      await page.getByText("beta #3", { exact: true }).count());
    const pull = page.locator(".git-panel").filter({ has: page.locator(".git-panel-note", { hasText: w.pinnedPr }) });
    check(tag + ": a pinned pull request shows its page under the pinned line, with Unpin", await visible(pull, 30000)
      && await visible(pull.getByRole("heading", { name: /Add greeting check/ }), 30000) && await visible(pull.getByRole("button", { name: w.unpin })));
    check(tag + ": the pinned pull request fits the panel", await overflow(page, ".git-panel") === 0, await overflow(page, ".git-panel"));
    await shot("panel-pinned-pr");
    await pull.getByRole("button", { name: w.unpin }).click();
    check(tag + ": Unpin closes the pinned pull request", await pull.first().waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false));

    if (language !== "en") {
      await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
      await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: "EN", exact: true }).click({ timeout: 30000 });
      await page.waitForTimeout(400);
    }
    check(tag + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 800));
} finally { await browser.close(); rmSync(join(stand, "home/projects/beta/panel-note.txt"), {force: true}); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
