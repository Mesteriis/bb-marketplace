// Run on a fresh isolated stand with acceptanceFixture and homeRedirect enabled.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const [url, tools, executablePath] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  await page.goto(url);
  const route = page.locator("[data-chertog-route]");
  const groups = route.locator("[data-group-id]");
  const frames = page.locator('iframe[src*="live-frame"]');
  await route.getByRole("button", { name: /Тестовая панель/ }).first().click();
  await page.getByRole("button", { name: "Добавить панель", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Тестовая панель/ }).first().click();
  await frames.nth(1).contentFrame().locator("#boot-id").waitFor();
  const input = frames.first().contentFrame().locator("#input");
  await input.fill("stage A");
  await input.evaluate(el => el.setSelectionRange(3, 3));
  const nodes = await frames.elementHandles();
  const boot = await Promise.all(nodes.map(async node => (await node.contentFrame()).locator("#boot-id").innerText()));
  const tileIds = () => groups.evaluateAll(els => els.map(el => el.dataset.groupId));
  const original = await tileIds();
  assert.equal(original.length, 2);
  await groups.first().getByRole("button", { name: "Развернуть" }).click();
  assert.equal(await groups.count(), 1);
  await groups.first().getByRole("button", { name: "Восстановить" }).click();
  assert.deepEqual(await tileIds(), original);
  // Since 79f18fa2 «Новый тред» is in BB's title bar. Selector updated; this historical probe was not re-run on the new look.
  await page.locator("header").getByRole("button", { name: "Новый тред", exact: true }).click();
  await page.waitForURL(new URL("/", url).href);
  await page.goBack();
  await groups.nth(1).waitFor();
  for (const [index, node] of nodes.entries()) {
    assert(await node.evaluate(el => el.isConnected));
    assert.equal(await (await node.contentFrame()).locator("#boot-id").innerText(), boot[index]);
  }
  assert.equal(await input.inputValue(), "stage A");
  assert.equal(await input.evaluate(el => el.selectionStart), 3);
  console.log("PASS Home redirect, 1→2→1→2, maximize/restore, new thread screen and Back: two original iframe nodes and boot IDs, draft and caret 3");
} finally {
  await browser.close();
}
