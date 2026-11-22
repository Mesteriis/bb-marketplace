// Ten thread opens on a 1440x900 window: each open halves a tile, so tile widths run 533, 267, 133, 66 ... and the bars wrap.
// node narrow.mjs <url> <tools> <chromium> <shots> <suffix>
import { createRequire } from "node:module";
const [url, tools, chrome, shots, SFX] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const b = await chromium.launch({ executablePath: chrome });
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = []; page.on("pageerror", e => errors.push(String(e).slice(0, 200)));
await page.goto(url + "plugins/chertog/home");
await page.locator("[data-chertog-route] [data-group-id]").first().waitFor({ timeout: 30000 });
await page.getByRole("link", { name: new RegExp("Узкий 0 " + SFX) }).first().waitFor({ timeout: 30000 });
for (let i = 0; i < 10; i++) { await page.locator("a").filter({ hasText: "Узкий " + i + " " + SFX }).first().click(); await page.waitForTimeout(900); }
await page.waitForTimeout(1500);
const nar = await page.evaluate(() => [...document.querySelectorAll("[data-chertog-route] [data-group-id]")].map(g => { const r = g.getBoundingClientRect(); const bar = g.querySelector("[data-tile-header]").getBoundingClientRect(); return { w: Math.round(r.width), barH: Math.round(bar.height), hasContext: !!g.querySelector("[data-tile-context]"), buttons: [...g.querySelectorAll("[data-tile-header] button")].filter(x => ["Добавить вкладку", "Действия тайла", "Развернуть", "Закрыть панель"].includes(x.getAttribute("aria-label"))).map(x => { const q = x.getBoundingClientRect(); const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { n: x.getAttribute("aria-label"), inside: q.left >= r.left && q.right <= r.right && q.bottom <= bar.bottom + 0.5, hit: hit === x || x.contains(hit) }; }) }; }));
await page.screenshot({ path: shots + "/1440x900-10-narrow-tiles.png", clip: { x: 320, y: 40, width: 1120, height: 200 } });
await page.screenshot({ path: shots + "/1440x900-10-narrow-tiles-full.png" });
const probed = nar.filter(t => t.w >= 50 && t.w < 220);
const bad = probed.filter(t => t.buttons.length !== 4 || !t.buttons.every(x => x.inside && x.hit));
console.log((bad.length === 0 && probed.length >= 2 && probed.some(t => t.w < 140) ? "ok   " : "FAIL ") + "tiles of 50-220px: all four bar buttons of every tile are inside it and get the pointer — " + JSON.stringify({ tiles: nar.length, probed: probed.map(t => t.w), widths: nar.map(t => t.w), barHeights: [...new Set(nar.map(t => t.barH))], context: nar.some(t => t.hasContext), bad }));
// the ✕ of a narrow tile closes it
const before = await page.locator("[data-chertog-route] [data-group-id]").count();
await page.locator("[data-chertog-route] [data-group-id]").nth(3).getByRole("button", { name: "Закрыть панель" }).click(); await page.waitForTimeout(700);
const after = await page.locator("[data-chertog-route] [data-group-id]").count();
console.log((after === before - 1 ? "ok   " : "FAIL ") + "✕ of a narrow tile closes it — " + JSON.stringify({ before, after }));
console.log((errors.length === 0 ? "ok   " : "FAIL ") + "no page errors — " + JSON.stringify(errors));
await b.close();
