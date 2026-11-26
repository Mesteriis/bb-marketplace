// Update acceptance on the stand without a development runtime: first install
// from the signed channel, update to the next build through GitWand's own
// update banner, rollback, and a tampered manifest.
// Usage: node update.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <thread> <channelDir> <channelPort>
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, toolsDir, chrome, out, project, thread, channel, port] = process.argv.slice(2);
const { chromium } = createRequire(toolsDir + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const results = [];
const check = (id, name, ok, detail) => {
  const r = { id, name, result: ok === null ? "не проверялось" : ok ? "прошло" : "не прошло", detail };
  results.push(r);
  console.log(`${r.id}\t${r.result}\t${r.name}\t${JSON.stringify(r.detail ?? "").slice(0, 300)}`);
};
const sleep = (ms) => page.waitForTimeout(ms);
const settingsText = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const row = async (label) => new RegExp(`${label} (.+?) (Бэкенд|Инструменты|Обновления|Перезапустить|Установить)`).exec(await settingsText())?.[1] ?? null;
const waitText = async (re, ms) => {
  for (let t = 0; t < ms; t += 500) {
    if (re.test(await settingsText())) return true;
    await sleep(500);
  }
  return false;
};
const settings = async () => {
  await page.goto(`${url}settings/plugins/makosh-gitwand`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Проверить обновления" }).waitFor({ timeout: 20000 });
};
const publish = (v) => execFileSync(`${channel}/publish.sh`, [v, port], { encoding: "utf8" });
const openTab = async () => {
  await page.goto(`${url}projects/${project}/threads/${thread}`, { waitUntil: "load" });
  await sleep(2500);
  await page.getByRole("button", { name: "GitWand", exact: true }).last().click();
  await page.locator('iframe[title="GitWand"]').waitFor({ timeout: 20000 });
  const frame = page.frameLocator('iframe[title="GitWand"]');
  await frame.getByText("modified").first().waitFor({ timeout: 30000 }).catch(() => {});
  return frame;
};

// First install: nothing installed, the channel offers +bb1.
await settings();
const before = await row("Рантайм");
await page.getByRole("button", { name: "Проверить обновления" }).click();
await waitText(/доступна 3\.14\.0\+bb1/, 20000);
await page.screenshot({ path: `${out}/u1-available.png`, fullPage: true });
await page.getByRole("button", { name: "Установить 3.14.0+bb1" }).click().catch((e) => errors.push("install bb1: " + e.message.split("\n")[0]));
const installed1 = await waitText(/Рантайм 3\.14\.0\+bb1 \(установлен\)/, 90000);
await page.screenshot({ path: `${out}/u2-installed.png`, fullPage: true });
let frame = await openTab();
const tabWorks1 = (await frame.getByText("modified").count()) > 0;
check("9a", "Первая установка рантайма из подписанного канала", installed1 && tabWorks1, { before, after: await (async () => (await settings(), await row("Рантайм")))(), tabWorks: tabWorks1 });

// Update to +bb2 through GitWand's own banner.
publish("3.14.0+bb2");
await settings();
await page.getByRole("button", { name: "Проверить обновления" }).click();
const offered = await waitText(/доступна 3\.14\.0\+bb2/, 20000);
frame = await openTab();
const install = frame.getByRole("button", { name: "Install and restart" });
const banner = await install.waitFor({ timeout: 20000 }).then(() => true, () => false);
await page.screenshot({ path: `${out}/u3-banner.png` });
if (banner) await install.click();
await sleep(15000);
await page.screenshot({ path: `${out}/u4-after-install.png` });
await settings();
const updated = await waitText(/Рантайм 3\.14\.0\+bb2 \(установлен\)/, 60000);
frame = await openTab();
const tabWorks2 = (await frame.getByText("modified").count()) > 0;
await settings();
check(9, "Обновление: баннер GitWand, установка, перезагрузка; новая версия работает", offered && banner && updated && tabWorks2, { offered, banner, runtime: await row("Рантайм"), backend: await row("Бэкенд"), tabWorks: tabWorks2 });
await page.screenshot({ path: `${out}/u5-updated.png`, fullPage: true });

// Rollback returns the previous build.
await page.getByRole("button", { name: "Откатить" }).click();
const rolledBack = await waitText(/Рантайм 3\.14\.0\+bb1 \(установлен\)/, 30000);
check("9b", "«Откатить» возвращает предыдущую сборку", rolledBack, await row("Рантайм"));

// A manifest changed after signing is refused.
appendFileSync(`${channel}/www/channel.json`, " ");
await page.getByRole("button", { name: "Проверить обновления" }).click();
const refused = await waitText(/ошибка: channel\.json: signature does not match the file/, 20000);
check("9c", "Манифест, изменённый после подписи, отклоняется", refused, await row("Обновления"));
await page.screenshot({ path: `${out}/u6-tampered.png`, fullPage: true });

check("errors", "Ошибки страницы", errors.length === 0, errors);
await browser.close();
