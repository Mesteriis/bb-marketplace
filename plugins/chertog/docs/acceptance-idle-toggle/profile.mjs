// profile.mjs STAND SCENARIO LABEL SECONDS OUTDIR: headless page on the stand, CDP Profiler, ws frame count, idle for N seconds.
import { createRequire } from "node:module";
import fs from "node:fs";
const [stand, scenario, label, seconds = "20", outdir] = process.argv.slice(2);
const url = fs.readFileSync(stand + "/env", "utf8").match(/^URL=(.*)$/m)[1];
const { chromium } = createRequire(stand + "/tools/")("playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const cdp = await page.context().newCDPSession(page);
let frames = 0, bytes = 0;
await cdp.send("Network.enable");
const sample = [];
cdp.on("Network.webSocketFrameReceived", (e) => { frames++; bytes += e.response.payloadData.length; if (sample.length < 4) sample.push(e.response.payloadData.slice(0, 400)); });
if (scenario === "home-tile") {
  await page.goto(url + "/plugins/chertog/home", { waitUntil: "load" });
  await page.waitForSelector("[data-chertog-route] [data-group-id]", { timeout: 30000 });
  await page.getByText("Основной тред", { exact: true }).first().click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
} else if (scenario === "home-picker") {
  await page.goto(url + "/plugins/chertog/home", { waitUntil: "load" });
  await page.waitForSelector("[data-chertog-route] [data-group-id]", { timeout: 30000 });
} else if (scenario === "thread-page") {
  await page.goto(url + "/threads/thr_other", { waitUntil: "load" });
} else throw new Error("scenario");
await page.waitForTimeout(4000);
const state = await page.evaluate(() => ({ path: location.pathname, tiles: document.querySelectorAll("[data-chertog-route] [data-group-id]").length, panels: document.querySelectorAll("[data-chertog-route] [role=tab]").length, pickerOpen: !!document.querySelector("[data-chertog-route] input[placeholder]") }));
frames = 0; bytes = 0;
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
await cdp.send("Performance.enable");
const m0 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
await cdp.send("Profiler.start");
await new Promise((r) => setTimeout(r, Number(seconds) * 1000));
const { profile } = await cdp.send("Profiler.stop");
const m1 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
const delta = {}; for (const k of ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"]) delta[k] = +(m1[k] - m0[k]).toFixed(3);
fs.writeFileSync(`${outdir}/${label}.cpuprofile`, JSON.stringify(profile));
fs.writeFileSync(`${outdir}/${label}.meta.json`, JSON.stringify({ scenario, seconds: Number(seconds), wsFramesDuringProfile: frames, wsBytes: bytes, delta, state, errors, sample }, null, 1));
console.log(label, JSON.stringify({ frames, delta, state, errors }));
await browser.close();
