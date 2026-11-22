// Click-to-tile and linked blocks on an isolated stand (see docs/e2e-stand.md and docs/acceptance-open.md).
// node open-from-sidebar.browser.mjs <stand-url> <playwright-tools-dir> <chromium> <stand-dir>
// Needs Chertog and Makosh Sidebar installed on the stand and these threads in the project:
// thr_main "Основной тред", its subthreads thr_sub1 "Субтред один" and thr_sub2 "Субтред два", thr_other "Другой тред", thr_fresh "Свежий тред" (unread, never opened by the probe).
import { createRequire } from "node:module";
const [url, tools, chrome, stand] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
const failures = [];
const step = (name, ok, detail) => {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail === undefined ? "" : " :: " + JSON.stringify(detail)));
  if (!ok) failures.push(name);
};
const home = url + "plugins/chertog/home";
const path = () => new URL(page.url()).pathname;
const groups = () => page.evaluate(() => [...document.querySelectorAll("[data-chertog-route] [data-group-id]")].map((g) => {
  const r = g.getBoundingClientRect();
  return { id: g.dataset.groupId, rect: [r.left, r.top, r.right, r.bottom].map(Math.round), tabs: [...g.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim()), title: g.getAttribute("aria-label") };
}));
const titled = (gs, title) => gs.find((g) => g.tabs.includes(title) || g.title === title);
const shot = (name) => page.screenshot({ path: stand + "/open-" + name + ".png" });
const dispatch = (detail) => page.evaluate((d) => {
  const detail = { ...d, accepted: false, outcome: null };
  window.dispatchEvent(new CustomEvent("chertog.open.v1", { detail }));
  return { accepted: detail.accepted, outcome: detail.outcome };
}, detail);
const row = (title) => page.locator("a").filter({ hasText: title }).first();

await page.goto(home);
await page.locator("[data-chertog-route] [data-group-id]").first().waitFor({ timeout: 30000 });
await page.getByRole("link", { name: /Основной тред/ }).first().waitFor({ timeout: 30000 });
let g = await groups();
step("start: one waiting picker tile on the Chertog page", g.length === 1 && g[0].tabs.length === 0, g);

// 1. Click a thread row: tile, URL unchanged.
await row("Основной тред").click();
await page.waitForTimeout(800);
g = await groups();
step("click on thread row opens a tile, URL stays on the Chertog page", path() === "/plugins/chertog/home" && g.some((x) => x.tabs.includes("Основной тред")), { path: path(), groups: g });
await shot("1-parent");

// 2. Same click again: same tile, no new one.
const before = g.length;
await row("Основной тред").click();
await page.waitForTimeout(800);
g = await groups();
const withMain = g.filter((x) => x.tabs.includes("Основной тред"));
step("second click focuses the same tile (no duplicate, no new tile)", withMain.length === 1 && g.length === before && path() === "/plugins/chertog/home", { groups: g.length, tiles: withMain.length });

// 3. Subthreads: expand and click.
await page.getByRole("button", { name: /Развернуть сабтреды: Основной тред/ }).click();
await row("Субтред один").waitFor();
await row("Субтред один").click();
await page.waitForTimeout(800);
g = await groups();
let parent = titled(g, "Основной тред"), s1 = titled(g, "Субтред один");
step("first subthread opens in a block to the right of its parent", !!s1 && s1.rect[0] >= parent.rect[2] - 2 && Math.abs(s1.rect[1] - parent.rect[1]) <= 2 && path() === "/plugins/chertog/home", { parent: parent.rect, s1: s1?.rect });
await row("Субтред два").click();
await page.waitForTimeout(800);
g = await groups();
parent = titled(g, "Основной тред"); s1 = titled(g, "Субтред один");
const s2 = titled(g, "Субтред два");
step("second subthread opens below the first, still in the block", !!s2 && s2.rect[1] >= s1.rect[3] - 2 && s2.rect[0] === s1.rect[0], { s1: s1.rect, s2: s2?.rect });
await shot("2-block");

// 4. Cmd-click: native handling (BB's own link navigation), no tile.
const tilesBefore = (await groups()).length;
const popup = context.waitForEvent("page", { timeout: 3000 }).catch(() => null);
await row("Другой тред").click({ modifiers: ["Meta"] });
const opened = await popup;
await page.waitForTimeout(1500);
const awayPath = path();
step("Cmd-click is not taken by Chertog: BB navigates to the thread itself", awayPath === "/threads/thr_other", { newBrowserTab: opened !== null, path: awayPath, tilesBeforeClick: tilesBefore });
if (opened) await opened.close();
await shot("3-cmd-click");

// BB opened the thread in a second pane next to Chertog, so Chertog is still shown: a request is still accepted.
const stillShown = await dispatch({ kind: "thread", threadId: "thr_main" });
step("while the Chertog pane is still open beside the thread, a request is accepted (focused)", stillShown.accepted === true && stillShown.outcome === "focused", stillShown);
// Close the Chertog pane.
await page.getByRole("button", { name: "Close pane" }).first().click();
await page.waitForTimeout(1000);
await shot("3b-chertog-closed");
// (b) Not shown: with the Chertog pane closed, the protocol answers not-shown and a row click navigates.
const notShown = await dispatch({ kind: "thread", threadId: "thr_other" });
step("(b) request while the Chertog page is not shown: accepted=false, outcome=not-shown", notShown.accepted === false && notShown.outcome === "not-shown", { path: path(), notShown });
const notShownPanel = await dispatch({ kind: "panel", ref: { provider: "bb-terminal", params: { terminalId: "term_stand" } } });
step("(b) same for a panel request", notShownPanel.accepted === false && notShownPanel.outcome === "not-shown", notShownPanel);
await row("Свежий тред").click();
await page.waitForTimeout(1500);
step("(b) click on a row outside the Chertog page navigates natively to the thread", path() === "/threads/thr_fresh", { from: awayPath, to: path() });

// Back to Chertog; the saved layout comes back.
await page.goto(home);
await page.locator("[data-chertog-route] [data-group-id]").first().waitFor();
await page.waitForTimeout(1500);
g = await groups();
step("layout with the block survives the trip away", !!titled(g, "Основной тред") && !!titled(g, "Субтред один") && !!titled(g, "Субтред два"), g.map((x) => x.tabs));

// (a) Another sender: panel request for a registered provider.
const panel = await dispatch({ kind: "panel", ref: { provider: "bb-terminal", params: { terminalId: "term_stand" } } });
await page.waitForTimeout(600);
const again = await dispatch({ kind: "panel", ref: { provider: "bb-terminal", params: { terminalId: "term_stand" } } });
const bad = await dispatch({ kind: "panel", ref: { provider: "no-such-provider", params: {} } });
const malformed = await page.evaluate(() => { const d = { kind: "thread", threadId: "", accepted: false, outcome: null }; window.dispatchEvent(new CustomEvent("chertog.open.v1", { detail: d })); return { accepted: d.accepted, outcome: d.outcome }; });
step("(a) panel request from another sender is accepted: opened", panel.accepted === true && panel.outcome === "opened", panel);
step("(a) repeating the panel request gives focused", again.accepted === true && again.outcome === "focused", again);
step("(a) unknown provider gives unsupported, accepted=false", bad.accepted === false && bad.outcome === "unsupported", bad);
step("(a) malformed request gives invalid, accepted=false", malformed.accepted === false && malformed.outcome === "invalid", malformed);
g = await groups();
step("(a) the terminal panel got a tile of its own", g.some((x) => x.tabs.some((t) => /терминал|term/i.test(t))), g.map((x) => x.tabs));
await shot("4-panel");

// (c) «Открыть рядом…» and close the parent with children.
const parentTile = page.locator("[data-chertog-route] [data-group-id]").filter({ has: page.getByRole("tab", { name: "Основной тред", exact: true }) });
await parentTile.getByRole("button", { name: "Действия тайла" }).click();
await page.getByRole("menuitem", { name: "Открыть рядом…" }).click();
await page.waitForTimeout(800);
const afterBeside = await groups();
const picker = afterBeside.filter((x) => x.tabs.includes("Выбор содержимого"));
const parentNow = titled(afterBeside, "Основной тред"), s2Now = titled(afterBeside, "Субтред два");
step("(c) «Открыть рядом…» adds a waiting picker tile in the parent's block (right column, under the subthreads)", picker.length === 1 && afterBeside.length === g.length + 1 && picker[0].rect[0] === s2Now.rect[0] && picker[0].rect[1] >= s2Now.rect[3] - 2, { before: g.length, after: afterBeside.length, picker: picker[0]?.rect, s2: s2Now.rect });
await shot("5-beside");
await page.getByRole("button", { name: "Выбрать", exact: true }).click();
await page.waitForTimeout(500);
await shot("5a-picker-open");
// The picker dialog is capped at the window height (Modal), so its top part is reachable; the search field still narrows the list.
await page.getByRole("dialog").getByRole("searchbox").fill("Другой тред");
await page.waitForTimeout(300);
await page.getByRole("dialog").locator('button[data-item-key=\'["bb-thread","thr_other"]\']').click();
await page.waitForTimeout(800);
g = await groups();
step("(c) choosing in that picker puts the thread in the parent's block (the picker tile is reused, no extra tile)", !!titled(g, "Другой тред") && g.length === afterBeside.length && !g.some((x) => x.tabs.includes("Выбор содержимого")), g.map((x) => x.tabs));
await shot("5b-chosen");

// (d) Keyboard move of the parent moves the block.
const rel = (gs) => { const p = titled(gs, "Основной тред"); return ["Субтред один", "Субтред два", "Другой тред"].map((t) => { const x = titled(gs, t); return [t, x.rect[0] - p.rect[0], x.rect[1] - p.rect[1]]; }); };
const relBefore = rel(g), posBefore = titled(g, "Основной тред").rect;
await parentTile.getByRole("tab", { name: "Основной тред", exact: true }).focus();
let moved = null, usedKey = null;
for (const key of ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"]) {
  await page.keyboard.press("Control+Alt+" + key);
  await page.waitForTimeout(500);
  const now = await groups();
  if (JSON.stringify(titled(now, "Основной тред").rect) !== JSON.stringify(posBefore)) { moved = now; usedKey = key; break; }
}
if (moved) {
  const relAfter = rel(moved);
  const sameShape = JSON.stringify(relAfter.map((r) => [r[0], Math.sign(r[1]), Math.sign(r[2])])) === JSON.stringify(relBefore.map((r) => [r[0], Math.sign(r[1]), Math.sign(r[2])]));
  step("(d) Ctrl+Alt+" + usedKey + " on the parent moves the parent, and the block keeps its relative arrangement", true, { posBefore, posAfter: titled(moved, "Основной тред").rect, relBefore, relAfter, sameShape });
  step("(d) children stay on the same sides of the parent after the move", sameShape, { relBefore, relAfter });
  await shot("6-moved");
} else step("(d) keyboard move of the parent changed the layout", false, "no arrow changed the parent's position");

// Close the main thread: one dialog with the count, closes the block.
g = await groups();
const total = g.length;
await parentTile.getByRole("tab", { name: "Основной тред", exact: true }).waitFor();
await page.getByRole("button", { name: "Закрыть: Основной тред", exact: true }).click({ force: true });
const dialog = page.getByRole("dialog").filter({ hasText: /Закрыть вместе с подчинёнными/ });
await dialog.waitFor({ timeout: 5000 });
const title = (await dialog.textContent()).match(/Закрыть вместе с подчинёнными \(\d+\)\?/)?.[0];
step("(c) closing the parent asks one «Закрыть вместе с подчинёнными (N)?»", title === "Закрыть вместе с подчинёнными (3)?", { title });
await shot("7-close-dialog");
await dialog.getByRole("button", { name: "Закрыть всё" }).click();
await page.waitForTimeout(1000);
// A second dialog (last view ends a session) may follow; record it.
const follow = await page.getByRole("dialog").count();
g = await groups();
step("closing the main thread closed the whole block", !g.some((x) => x.tabs.some((t) => ["Основной тред", "Субтред один", "Субтред два", "Другой тред"].includes(t))), { followUpDialogs: follow, left: g.map((x) => x.tabs) });
await shot("8-closed");

step("no page errors during the whole run", errors.length === 0, errors);
await browser.close();
if (failures.length) { console.error("FAILED: " + failures.join("; ")); process.exit(1); }
console.log("PROBE PASS");
