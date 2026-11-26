// Clean install from the marketplace: no runtime on disk, the real signed
// channel offers 3.14.0+bb1, Install brings it up and the tab works.
// Usage: node market.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <thread>
import { createRequire } from "node:module";
const [url, toolsDir, chrome, out, project, thread] = process.argv.slice(2);
const { chromium } = createRequire(toolsDir + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const row = async (label) => new RegExp(`${label} (.+?) (Бэкенд|Инструменты|Обновления|Перезапустить|Установить|Проверить)`).exec(await text())?.[1] ?? null;
const waitText = async (re, ms) => { for (let t = 0; t < ms; t += 500) { if (re.test(await text())) return true; await page.waitForTimeout(500); } return false; };
const settings = async () => {
  await page.goto(`${url}settings/plugins/makosh-gitwand`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Проверить обновления" }).waitFor({ timeout: 30000 });
};
const res = {};
await settings();
res.before = await row("Рантайм");
await page.getByRole("button", { name: "Проверить обновления" }).click();
res.offered = await waitText(/доступна 3\.14\.0\+bb1/, 30000);
await page.screenshot({ path: `${out}/m1-offered.png`, fullPage: true });
await page.getByRole("button", { name: "Установить 3.14.0+bb1" }).click().catch((e) => errors.push("install: " + e.message.split("\n")[0]));
res.installed = await waitText(/Рантайм 3\.14\.0\+bb1 \(установлен\)/, 180000);
res.after = await row("Рантайм");
res.backend = await row("Бэкенд");
await page.screenshot({ path: `${out}/m2-installed.png`, fullPage: true });
await page.goto(`${url}projects/${project}/threads/${thread}`, { waitUntil: "load" });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: "GitWand", exact: true }).last().click();
await page.locator('iframe[title="GitWand"]').waitFor({ timeout: 20000 });
const frame = page.frameLocator('iframe[title="GitWand"]');
res.tabWorks = await frame.getByText("modified").first().waitFor({ timeout: 40000 }).then(() => true, () => false);
await page.screenshot({ path: `${out}/m3-tab.png` });
res.errors = errors;
console.log(JSON.stringify(res, null, 2));
await browser.close();
process.exit(res.offered && res.installed && res.tabWorks && errors.length === 0 ? 0 : 1);
