// Isolated BB with a registered fixture project containing preview.html
// (copy the adjacent preview.html). Pass stand URL, playwright tools, Chromium, fixture.txt.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const [url, tools, executablePath, file] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(new URL("/plugins/chertog/home", url).href);
  await page.getByRole("button", { name: "Добавить панель", exact: true }).click();
  const picker = page.getByRole("dialog").getByRole("region", { name: "BB предпросмотр", exact: true });
  await picker.getByRole("button", { name: "Выбрать среду" }).click();
  await picker.getByLabel("Рабочая среда").selectOption({ index: 1 });
  await picker.getByRole("textbox", { name: "Путь к файлу" }).fill("preview.html");
  await picker.getByRole("button", { name: "Найти", exact: true }).click();
  await picker.getByRole("button", { name: /preview.html/ }).click();

  const iframe = page.locator('iframe[title="preview.html"]');
  const frame = iframe.contentFrame();
  const input = frame.locator("#inline");
  const styled = frame.locator("#stylesheet");
  const editor = frame.locator("#editor");
  await input.waitFor();
  const paragraph = iframe.contentFrame().getByText("HTML preview", { exact: true });
  const source = await iframe.evaluate(el => [el.src, el.srcdoc]);
  const original = await input.evaluateHandle(el => el.ownerDocument);
  const markup = await original.evaluate(doc => doc.documentElement.outerHTML);
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  const drag = (type, at) => cdp.send("Input.dispatchDragEvent", { type, ...at, data });
  // Let BB finish fetching the preview before counting requests during the drops.
  await page.waitForLoadState("networkidle");
  const previewFrame = await (await iframe.elementHandle()).contentFrame();
  assert(previewFrame);
  const requests = [];
  page.on("request", request => {
    // The BB shell polls window state independently of the preview.
    for (let sourceFrame = request.frame(); sourceFrame; sourceFrame = sourceFrame.parentFrame()) {
      if (sourceFrame === previewFrame) {
        requests.push(request.url());
        break;
      }
    }
  });
  // Direct entry into the frame can be the first event from the OS.
  for (const target of [input, styled, editor, paragraph]) {
    const box = await target.boundingBox();
    assert(box);
    const point = { x: box.x + 10, y: box.y + box.height / 2 };
    await drag("dragEnter", point);
    await drag("dragOver", point);
    await drag("drop", point);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await paragraph.waitFor();
    assert.equal(await input.evaluate((el, doc) => el.ownerDocument === doc, original), true);
    assert.deepEqual(await frame.locator("input").evaluateAll(inputs => inputs.map(el => el.files.length)), [0, 0]);
    assert.deepEqual(await iframe.evaluate(el => [el.src, el.srcdoc]), source);
    assert.equal(await original.evaluate(doc => doc.documentElement.outerHTML), markup);
  }
  assert.equal(await editor.evaluate(el => el.isContentEditable), false);
  assert.deepEqual(requests, []);
  console.log("PASS OS file drops on inline-styled and stylesheet-styled file inputs, editable fixture and ordinary text kept original document, source and content; zero files and preview requests");
} finally {
  await browser.close();
}
