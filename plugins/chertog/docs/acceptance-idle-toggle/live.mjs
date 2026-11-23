// live.mjs STAND OUTDIR: one page kept open on /plugins/chertog/home; the tile-space switch is flipped with the bb CLI while the page stays open.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const [stand, out] = process.argv.slice(2);
const url = fs.readFileSync(stand + "/env", "utf8").match(/^URL=(.*)$/m)[1];
const { chromium } = createRequire(stand + "/tools/")("playwright-core");
const cli = (...a) => execFileSync(process.env.STAND_CLI, [stand, ...a], { encoding: "utf8" });
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const state = () => page.evaluate(() => ({ path: location.pathname,
  tiles: [...document.querySelectorAll("[data-chertog-route] [data-group-id]")].map((t) => ({ tabs: [...t.querySelectorAll("[role=tab]")].map((x) => x.textContent.trim()), handoffCard: t.innerText.includes("Вернуть панель в это окно"), retryCard: t.innerText.includes("Повторить"), body: t.innerText.replace(/\s+/g, " ").slice(0, 120) })),
  notice: document.body.innerText.includes("Тайловое пространство выключено") }));
const step = async (name, fn) => { if (fn) await fn(); await page.waitForTimeout(2500); const s = await state(); fs.writeFileSync(`${out}/${name}.json`, JSON.stringify({ ...s, errors }, null, 1)); await page.screenshot({ path: `${out}/${name}.png` }); console.log(name, JSON.stringify(s)); };
await page.goto(url + "/plugins/chertog/home", { waitUntil: "load" });
await page.waitForSelector("[data-chertog-route] [data-group-id]", { timeout: 30000 });
await step("L0-start");
if (process.env.EXPLORE) { await browser.close(); process.exit(0); }
await step("L1-switch-on-click-sidebar", async () => { await page.locator("[data-chertog-route] ~ * , body").first(); await page.getByText("Тред номер 1", { exact: true }).first().click({ timeout: 10000 }); });
await step("L2-switch-on-click-again-focuses", async () => { await page.getByText("Тред номер 1", { exact: true }).first().click({ timeout: 10000 }); });
await step("L3-switch-off", async () => { cli("plugin", "config", "chertog", "set", "tileSpace", "false"); await page.waitForTimeout(2500); });
await step("L4-switch-off-click-sidebar", async () => { await page.getByText("Другой тред", { exact: true }).first().click({ timeout: 10000 }); await page.waitForTimeout(1500); });
await step("L5-switch-on-again-on-thread-page", async () => { cli("plugin", "config", "chertog", "set", "tileSpace", "true"); await page.waitForTimeout(2500); });
await step("L6-back-to-chertog-same-page", async () => { await page.goBack(); await page.waitForTimeout(1500); });
await browser.close();
