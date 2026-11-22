// Run on the isolated BB stand with Chertog and Telegram installed, using
// <stand-url> <playwright-tools-dir> <chromium>. Only Telegram RPC is simulated.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const [url, tools, executablePath] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const calls = [];
try {
  const chats = ["Synthetic A", "Synthetic B"].map((name, index) => ({
    id: String(21 + index), name,
    resourceRef: index ? "12345678-1234-4123-8123-123456789abd" : "12345678-1234-4123-8123-123456789abc",
  }));
  await page.route("**/api/v1/plugins/makosh-telegram/rpc/*", async route => {
    const method = new URL(route.request().url()).pathname.split("/").pop();
    const input = route.request().postDataJSON();
    let result;
    if (method === "status") result = { state: "ready", connectionId: "12345678-1234-4123-8123-123456789aaa" };
    if (method === "sessionRpc") {
      const { method: operation, payload } = input;
      calls.push(operation === "embedChatAction" ? payload.method : operation);
      if (operation === "embedChatChoices") result = chats.map(({ id, name }) => ({ id, name }));
      if (operation === "bindEmbedChat") result = chats.find(chat => chat.id === payload.id)?.resourceRef;
      if (operation === "resolveEmbedChat") {
        const { id, name } = chats.find(chat => chat.resourceRef === payload.resourceRef);
        result = { list: "main", chat: { id, name, initials: "ST", color: "#246dbd", subtitle: "Group", messages: [] } };
      }
      if (operation === "embedChatAction" && payload.method === "history") result = { before: null, messages: [] };
      if (operation === "embedChatAction" && payload.method === "chatDraft") result = { draft: null, writable: true };
    } else calls.push(method);
    await route.fulfill({ json: result === undefined ? { ok: false, error: "Unavailable on fixture" } : { ok: true, result } });
  });
  await page.goto(new URL("/plugins/chertog/home", url).href);
  for (const chat of chats) {
    await page.getByRole("button", { name: "Добавить панель", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Добавить вид Telegram/ }).click();
    await page.getByRole("button", { name: chat.name, exact: true }).click();
    await page.locator("[data-live-host]").filter({ has: page.getByRole("heading", { name: chat.name, exact: true }) })
      .getByRole("textbox", { name: "Write a message" }).waitFor();
  }
  const hosts = page.locator("[data-live-host]");
  const fields = hosts.getByRole("textbox", { name: "Write a message" });
  await fields.nth(0).fill("first");
  await fields.nth(1).fill("second");
  await fields.nth(0).focus();
  const geometry = () => hosts.evaluateAll(nodes => nodes.map(node => [node.dataset.liveHost, node.getBoundingClientRect().toJSON()]));
  const before = await geometry();
  await fields.nth(1).evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["fixture"], "owner-drop.txt", { type: "text/plain" }));
    for (const type of ["dragover", "drop"]) {
      element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  });
  await hosts.nth(1).getByText("owner-drop.txt", { exact: true }).first().waitFor();
  assert.equal(await hosts.nth(0).getByText("owner-drop.txt", { exact: true }).count(), 0);
  assert.equal(await fields.nth(0).inputValue(), "first");

  assert.deepEqual(await geometry(), before);
  const tile = page.locator("[data-group-id]").filter({ has: page.getByRole("tab", { name: "Telegram", exact: true }) }).first();
  await tile.getByRole("button", { name: "Действия тайла" }).click();
  const transfer = tile.getByRole("menuitem", { name: /Передать в другое окно/ });
  assert.equal(await transfer.isDisabled(), true);
  assert.match(await transfer.innerText(), /Переместите целое окно BB/);
  assert.match(await transfer.innerText(), /New Window/);
  assert(calls.includes("history"));
  assert.deepEqual(calls.filter(method => /send|upload/i.test(method)), []);
  console.log("PASS Telegram owner portals: one target draft, geometry unchanged, zero send/upload calls");
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-3500));
  throw error;
} finally {
  await browser.close();
}
