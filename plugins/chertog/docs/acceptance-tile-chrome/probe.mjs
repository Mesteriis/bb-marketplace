// Tile chrome probe on the isolated stand (docs/acceptance-tile-chrome.md).
// node probe.mjs <stand-url> <playwright-tools-dir> <chromium> <shots-dir> <width> <height> <seed-suffix>
// Needs Chertog (acceptanceFixture on) and Makosh Sidebar, and three unread threads titled
// "Тред альфа <suffix>", "Тред бета <suffix>", "Тред гамма <suffix>" (`node seed.mjs <bb.db> probe <suffix>`). Use a fresh suffix per run.
import { createRequire } from "node:module";
const [url, tools, chrome, shots, W, H, SFX] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const b = await chromium.launch({ executablePath: chrome });
const ctx = await b.newContext({ viewport: { width: +W, height: +H } });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(String(e).slice(0, 200)));
const tag = `${W}x${H}`;
const log = []; const fails = [];
const check = (n, ok, d) => { const l = (ok ? "ok   " : "FAIL ") + tag + " " + n + (d === undefined ? "" : " — " + JSON.stringify(d)); log.push(l); console.log(l); if (!ok) fails.push(n); };
const shot = (n, o = {}) => page.screenshot({ path: `${shots}/${tag}-${n}.png`, ...o });
const tiles = () => page.evaluate(() => [...document.querySelectorAll("[data-chertog-route] [data-group-id]")].map(g => {
  const r = g.getBoundingClientRect(); const bar = g.querySelector("[data-tile-header]"); const br = bar?.getBoundingClientRect();
  return { id: g.dataset.groupId, rect: [r.left, r.top, r.right, r.bottom].map(Math.round), tabs: [...g.querySelectorAll("[role=tab]")].map(t => t.textContent.trim()), bar: br && [br.left, br.top, br.right, br.bottom].map(Math.round), border: getComputedStyle(g).borderTopColor, buttons: [...g.querySelectorAll("[data-tile-header] button")].map(x => x.getAttribute("aria-label") || x.innerText.trim()) };
}));
const title = () => page.evaluate(() => document.querySelector("[data-chertog-header-title]")?.innerText.replace(/\s+/g, " ").trim());
await page.goto(url + "plugins/chertog/home");
await page.locator("[data-chertog-route] [data-group-id]").first().waitFor({ timeout: 30000 });
await page.getByRole("link", { name: /Основной тред/ }).first().waitFor({ timeout: 30000 });
const back = page.getByRole("button", { name: "Вернуть панель в это окно" }); while (await back.count()) { await back.first().click(); await page.waitForTimeout(400); }
for (let i = 0; i < 12; i++) { const c = page.locator("[data-chertog-route] [data-group-id]").first().getByRole("button", { name: "Закрыть панель" }); if (!(await c.count())) break; await c.click(); await page.waitForTimeout(300); const dlg = page.getByRole("dialog"); if (await dlg.count()) { await dlg.getByRole("button", { name: /^Закрыть/ }).first().click(); } await page.waitForTimeout(400); }
await page.waitForTimeout(500);
const row = t => page.locator("a").filter({ hasText: t }).first();
await row("Тред альфа " + SFX).click(); await page.waitForTimeout(1500);
await row("Тред бета " + SFX).click(); await page.waitForTimeout(1500);
let t = await tiles();
check("two thread tiles", t.length === 2 && t.every(x => x.tabs.length === 1), t.map(x => x.tabs));
// third: a tile with tabs (thread tab + fixture tab through «Добавить вкладку»)
await page.locator("[data-chertog-route] [data-group-id]").nth(1).getByRole("button", { name: "Добавить вкладку" }).click();
await page.getByRole("dialog").getByRole("button", { name: /Тестовая панель/ }).click(); await page.waitForTimeout(1500);
t = await tiles();
check("a tile with tabs exists", t.some(x => x.tabs.length === 2), t.map(x => x.tabs));
await row("Тред гамма " + SFX).click(); await page.waitForTimeout(1500);
t = await tiles();
log.push("tiles: " + JSON.stringify(t.map(x => [x.tabs, x.rect])));
await shot("1-tiles-threads-and-tabs");
check("each tile bar is 24px and has + ⋯ ▢ ✕", t.every(x => x.bar[3] - x.bar[1] === 24) && t.every(x => ["Добавить вкладку", "Действия тайла", "Развернуть", "Закрыть панель"].every(n => x.buttons.includes(n))), t.map(x => [x.bar[3] - x.bar[1], x.buttons]));
// no row over the thread: live hosts sit exactly on the tile body; a grid of hit tests inside each host reaches only the host itself
const over = await page.evaluate(() => { const active = new Set([...document.querySelectorAll("[role=tab][aria-selected=true]")].map(t => t.closest("[data-panel-id]")?.dataset.panelId)); return [...document.querySelectorAll("[data-live-host][data-panel-id]")].filter(h => active.has(h.dataset.panelId)).map(h => {
  const hr = h.getBoundingClientRect();
  const g = [...document.querySelectorAll("[data-chertog-route] [data-group-id]")].find(x => { const r = x.getBoundingClientRect(); return hr.left >= r.left - 1 && hr.right <= r.right + 1 && hr.top >= r.top && hr.bottom <= r.bottom + 1; });
  const bar = g?.querySelector("[data-tile-header]")?.getBoundingClientRect();
  const alien = [];
  for (let i = 1; i < 6; i++) for (let j = 1; j < 6; j++) { const e = document.elementFromPoint(hr.left + hr.width * i / 6, hr.top + hr.height * j / 6); if (e && !h.contains(e)) alien.push(e.tagName + "." + String(e.className).slice(0, 40)); }
  return { panel: h.dataset.panelId, tile: g?.dataset.groupId, hostTop: Math.round(hr.top), barBottom: bar && Math.round(bar.bottom), hostRect: [hr.left, hr.top, hr.right, hr.bottom].map(Math.round), thread: !!h.querySelector("[contenteditable=true]"), alien };
}); });
check("live content starts at the bar's bottom, inside a tile", over.length >= 2 && over.every(o => o.tile && Math.abs(o.hostTop - o.barBottom) <= 1), over);
check("thread views are not covered by any outside element (25-point hit grid)", over.some(o => o.thread) && over.every(o => o.alien.length === 0), over.map(o => [o.tile, o.thread, o.alien]));
// focus: header title follows
const titles = [];
for (const x of t) { await page.mouse.click(x.bar[0] + 20, x.bar[1] + 12); await page.waitForTimeout(400); const tt = await tiles(); titles.push({ clicked: x.tabs, title: await title(), primary: tt.map(y => y.border) }); await shot("2-focus-" + (titles.length)); }
check("focusing another tile changes the title bar", new Set(titles.map(x => x.title)).size === titles.length, titles.map(x => x.title));
check("focused tile has its own border colour", titles.every(x => new Set(x.primary).size === 2), titles.map(x => x.primary));
// right side of the title bar
const hdrBtns = await page.evaluate(() => [...document.querySelectorAll("header [role=toolbar] button")].map(b => b.getAttribute("aria-label") || b.innerText.trim()));
check("title bar right side has layout, + Панель, Скрытые, Новый тред", ["Раскладка", "Добавить панель", "Скрытые панели", "Новый тред"].every(n => hdrBtns.some(b => b.startsWith(n))), hdrBtns);
await page.locator('header [aria-label^="Раскладка"]').click(); await page.waitForTimeout(300);
check("layout list opens", await page.getByRole("dialog", { name: "Раскладки" }).isVisible());
await shot("3-layouts"); await page.keyboard.press("Escape"); await page.waitForTimeout(200);
await page.locator('header [aria-label="Добавить панель"]').click(); await page.waitForTimeout(300);
check("+ Панель opens the picker", await page.getByRole("dialog", { name: "Добавить панель" }).isVisible());
await shot("4-picker"); await page.keyboard.press("Escape"); await page.waitForTimeout(200);
await page.locator('header [aria-label^="Скрытые панели"]').click(); await page.waitForTimeout(300);
await shot("5-hidden"); await page.keyboard.press("Escape"); await page.waitForTimeout(200);
// divider drag
const div = page.locator("[data-divider]").first();
const d0 = await div.boundingBox(); const t0 = await tiles();
await page.mouse.move(d0.x + d0.width / 2, d0.y + d0.height / 2); await page.mouse.down(); await page.mouse.move(d0.x + d0.width / 2 - 80, d0.y + d0.height / 2, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(500);
const d1 = await div.boundingBox(); const t1 = await tiles();
check("divider drag moved the divider by 80px and resized tiles", Math.abs(d1.x - d0.x + 80) <= 2 && t1[0].rect[2] !== t0[0].rect[2], { d0: d0.x, d1: d1.x });
await shot("6-after-drag");
const over2 = await page.evaluate(() => { const active = new Set([...document.querySelectorAll("[role=tab][aria-selected=true]")].map(t => t.closest("[data-panel-id]")?.dataset.panelId)); return [...document.querySelectorAll("[data-live-host][data-panel-id]")].filter(h => active.has(h.dataset.panelId)).map(h => { const hr = h.getBoundingClientRect(); const g = [...document.querySelectorAll("[data-chertog-route] [data-group-id]")].find(x => { const r = x.getBoundingClientRect(); return hr.left >= r.left - 1 && hr.right <= r.right + 1 && hr.top >= r.top && hr.bottom <= r.bottom + 1; }); const bar = g?.querySelector("[data-tile-header]")?.getBoundingClientRect(); return { panel: h.dataset.panelId, tile: g?.dataset.groupId ?? null, hostTop: Math.round(hr.top), barBottom: bar && Math.round(bar.bottom) }; }); });
check("after the drag live content stays inside its tile, under the bar (at least two hosts matched)", over2.length >= 2 && over2.every(o => o.tile !== null && Math.abs(o.hostTop - o.barBottom) <= 1), over2);
// ✕ closes the panel
const before = await tiles();
const target = before.find(x => x.tabs.length === 1 && x.tabs[0] === "Тред гамма " + SFX) ?? before.at(-1);
await shot("7-before-close");
await page.locator(`[data-group-id="${target.id}"]`).getByRole("button", { name: "Закрыть панель" }).click(); await page.waitForTimeout(800);
const after = await tiles();
check("tile-bar ✕ closed the panel (tile gone, others stay)", after.length === before.length - 1 && !after.some(x => x.id === target.id), { before: before.map(x => x.tabs), after: after.map(x => x.tabs) });
await shot("8-after-close");
// ✕ on a tile with tabs closes only the active tab
const tabbed = after.find(x => x.tabs.length === 2);
if (tabbed) {
  await page.locator(`[data-group-id="${tabbed.id}"]`).getByRole("button", { name: "Закрыть панель" }).click(); await page.waitForTimeout(800);
  const a2 = (await tiles()).find(x => x.id === tabbed.id);
  check("✕ on a tile with tabs closes the active tab only", a2 && a2.tabs.length === 1, { was: tabbed.tabs, now: a2?.tabs });
  await shot("9-after-tab-close");
}
await page.locator('header button:has-text("Новый тред")').click(); await page.waitForTimeout(800);
check("«Новый тред» left the Chertog route", !new URL(page.url()).pathname.includes("plugins/chertog"), new URL(page.url()).pathname);
check("no page errors", errors.length === 0, errors);
await b.close();
if (fails.length) { console.error("PROBE FAIL: " + fails.join("; ")); process.exit(1); }
console.log("PROBE PASS");
