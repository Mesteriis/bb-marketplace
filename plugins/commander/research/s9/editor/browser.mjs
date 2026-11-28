import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

const [stand, chrome] = process.argv.slice(2);
const url = (await fs.readFile(stand + '/url', 'utf8')).trim();
const browser = await chromium.launch({ executablePath: chrome });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => console.error(error.message));
  await page.goto(new URL('/plugins/s9-preview/s9-preview', url).href);
  await page.getByRole('button', { name: 'Create synthetic copy' }).click();
  await page.getByText('Copy ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open without explicit opener' }).click();
  await page.getByText('Preview accepted', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', {name: 'S9 private copy'}).count(), 0);
  await page.getByRole('button', { name: 'Open in S9 editor' }).click();
  const editor = page.getByRole('textbox', {name: 'S9 private copy'});
  await editor.waitFor();
  assert.equal(await editor.inputValue(), 's9-before\n');
  await editor.fill('s9-after\n');
  await page.getByRole('button', {name: 'Save private copy'}).click();
  await page.getByText('Saved and reread via host RPC', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Reread from disk'}).click();
  await page.getByText('Read via host RPC', {exact: true}).waitFor();
  assert.equal(await editor.inputValue(), 's9-after\n');
  await page.screenshot({path: stand + '/s9-editor-saved.png'});
  console.log('PASS empty extensions, explicit opener, write and independent read via host RPC');
} catch (error) {
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
