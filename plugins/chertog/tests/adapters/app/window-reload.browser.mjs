// On the isolated stand: panel ownership across a window reload, a closed window, and a live handoff.
// Seed the stand with docs/acceptance-tile-chrome/seed.mjs (thread «Передача окна»), then run
//   node window-reload.browser.mjs <stand-url> <playwright-tools-dir> <chromium> <stand-bb.db> <screenshot-dir>
// Exits 1 if any step fails; each step is reported on its own line.
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, tools, executablePath, , shots] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const card = "Вернуть панель в это окно";
const composer = (page) => page.locator("[data-chertog-panel] [contenteditable=true]");
const open = async () => {
  const page = await context.newPage();
  await page.goto(new URL("/plugins/chertog/home", url).href);
  return page;
};
const openThread = async (page) => {
  await page.locator("[data-chertog-route]").getByRole("button", { name: /Передача окна/ }).first().click();
};
const shot = (page, name) => page.screenshot({ path: join(shots, name + ".png") });
let failed = 0;
async function step(name, run) {
  try {
    await run();
    console.log("PASS " + name);
  } catch (error) {
    failed++;
    console.log("FAIL " + name + ": " + String(error.message).split("\n")[0]);
  }
}
const waitComposer = (page, timeout = 15000) => composer(page).first().waitFor({ timeout });
const noCard = async (page) => {
  if ((await page.getByRole("button", { name: card }).count()) !== 0) throw new Error("the card «" + card + "» is shown");
};

const a = await open();
await step("window A opens the thread tile and owns it", async () => {
  await openThread(a);
  await waitComposer(a);
  await shot(a, "1-owner-before-reload");
});
await step("reload of A keeps the thread rendered, no card, no click", async () => {
  await a.reload();
  try {
    await waitComposer(a);
  } finally {
    await shot(a, "2-owner-after-reload");
  }
  await noCard(a);
});
await step("a second reload of A behaves the same", async () => {
  await a.reload();
  await waitComposer(a);
  await noCard(a);
});

const b = await open();
await step("live owner A keeps the panel: B sees the ownership note, no card, no composer", async () => {
  // The layout is shared, so B restores the same thread tile.
  try {
    await b.getByText(/Панель в окне/).first().waitFor({ timeout: 15000 });
  } finally {
    await shot(b, "3-live-owner-b-waits");
  }
  await b.waitForTimeout(7000);
  await noCard(b);
  if ((await composer(b).count()) !== 0) throw new Error("B rendered the composer while A is alive");
  if ((await composer(a).count()) === 0) throw new Error("A lost its composer");
});
await step("closing A lets B take the panel without a click", async () => {
  await a.close();
  try {
    await waitComposer(b);
  } finally {
    await shot(b, "4-b-after-a-closed");
  }
  await noCard(b);
});

const c = await open();
await step("two live windows: B hands the panel to C, C accepts", async () => {
  await c.getByText(/Панель в окне/).first().waitFor({ timeout: 15000 });
  const panelId = await composer(b).first().locator("xpath=ancestor::*[@data-live-host]").getAttribute("data-panel-id");
  const tile = b.locator("[data-group-id]").filter({ has: b.locator('[data-panel-id="' + panelId + '"]') });
  await tile.getByRole("button", { name: "Действия тайла" }).click();
  await b.getByRole("menuitem", { name: /^Передать в окно / }).click();
  await c.getByRole("button", { name: "Принять", exact: true }).click();
  await waitComposer(c);
  await b.getByText(/Панель в окне/).first().waitFor({ timeout: 15000 });
  await noCard(b);
  await noCard(c);
  await shot(c, "5-handoff-receiver");
  await shot(b, "5-handoff-source");
});
// A receiver that leaves hands the panel back to its source (docs/stage-c-windows.md), reload or not.
await step("a reload of the receiver C returns the panel to B, C shows no card", async () => {
  await c.reload();
  try {
    await waitComposer(b);
    await c.getByText(/Панель в окне/).first().waitFor({ timeout: 15000 });
  } finally {
    await shot(c, "6-receiver-after-reload");
    await shot(b, "6-source-after-receiver-reload");
  }
  await noCard(c);
  await noCard(b);
});
await browser.close();
console.log(failed === 0 ? "PROBE PASS" : "PROBE FAIL: " + failed);
process.exit(failed === 0 ? 0 : 1);
