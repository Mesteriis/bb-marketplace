// On the isolated stand, seed two idle threads titled «Передача окна» and
// «Соседний тред». Run with <stand-url> <playwright-tools-dir> <chromium> <stand-bb.db>.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";

const [url, tools, executablePath, databasePath] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const open = async () => {
  const page = await context.newPage();
  await page.goto(new URL("/plugins/chertog/home", url).href);
  return page;
};

async function drop(locator) {
  await locator.evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["local"], "stand-drop.txt", { type: "text/plain" }));
    for (const type of ["dragover", "drop"]) {
      element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
  });
}

const groups = page => page.locator("[data-group-id]").evaluateAll(elements =>
  elements.map(group => [group.dataset.groupId, [...group.querySelectorAll("[data-panel-id]")].map(tab => tab.dataset.panelId), group.style.cssText]));
const live = page => page.locator("[data-chertog-panel]").filter({ has: page.getByRole("button", { name: "Передать в другое окно", exact: true }) });
try {
  const source = await open();
  await source.locator("[data-chertog-route]").getByRole("button", { name: /Передача окна/ }).first().click();
  await source.locator("[data-chertog-panel] [contenteditable=true]").first().waitFor();
  await source.getByRole("button", { name: "Добавить панель", exact: true }).click();
  await source.getByRole("dialog").getByRole("region", { name: "Треды" }).getByRole("button", { name: /Соседний тред/ }).click();
  const panels = live(source);
  await panels.nth(1).getByRole("button", { name: "Передать в другое окно" }).waitFor();
  const target = panels.nth(0);
  const neighbor = panels.nth(1);
  const before = await groups(source);
  await neighbor.locator("[contenteditable=true]").first().click();
  await drop(target.locator("[contenteditable=true]").first());
  await target.getByText("stand-drop.txt", { exact: true }).first().waitFor({ state: "attached" });
  assert.equal(await neighbor.getByText("stand-drop.txt", { exact: true }).count(), 0);
  await drop(source.locator("[data-tile-header]").last());
  assert.deepEqual(await groups(source), before);
  console.log("PASS two BB composers and tile layout");
  async function transfer() {
    const receiver = await open();
    await target.getByRole("button", { name: "Передать в другое окно", exact: true }).click();
    await target.getByRole("button", { name: /^Окно / }).click();
    await receiver.getByRole("button", { name: "Принять", exact: true }).click();
    await source.locator("[data-chertog-panel]").filter({ hasText: /Панель в окне/ }).first().waitFor();
    await receiver.getByRole("button", { name: "Передать в другое окно", exact: true }).click();
    await receiver.getByText(/^Это окно /).waitFor();
    return receiver;
  }
  const receiver = await transfer();
  await receiver.close();
  await source.getByRole("status").filter({ hasText: /возвращена в это окно/ }).waitFor({ timeout: 15000 });
  await source.getByRole("button", { name: "Понятно", exact: true }).click();
  await panels.nth(1).getByRole("button", { name: "Передать в другое окно" }).waitFor();

  const last = await transfer();
  await source.close();
  await last.getByText("Откройте второе окно через New Window.").waitFor();
  await last.close();
  const restored = await open();
  await restored.getByRole("button", { name: "Вернуть панель в это окно" }).first().waitFor();
  assert.equal(await restored.locator("[data-chertog-panel] [contenteditable=true]").count(), 0);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for (const table of ["events", "queued_thread_messages"]) {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM " + table + " WHERE thread_id IN ('thr_handoff','thr_neighbor')").get().n, 0);
    }
    const rows = db.prepare("SELECT status FROM threads WHERE id IN ('thr_handoff','thr_neighbor')").all();
    assert.deepEqual(rows.map(row => row.status), ["idle", "idle"]);
  } finally {
    db.close();
  }
  console.log("PASS closed receiver restored the source, last receiver left the thread hidden, both threads idle, zero sends");
} catch (error) {
  for (const page of context.pages()) console.error((await page.locator("body").innerText()).slice(-4000));
  throw error;
} finally {
  await browser.close();
}
