// Browser probe on the isolated stand: the Git panel attaches the project's copy, the repository panel shows the
// forge detected from its SSH origin and that no account is connected. Last line is PASS or FAIL.
// Usage: node smoke.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <repo>
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
/** Picks the project source whose path ends with `suffix` in the attach form, when the form offers a choice. */
async function chooseCopy(page, suffix) {
  const select = page.locator(".git-add-copy select").first();
  if (!await select.count()) return;
  const value = await select.locator("option").evaluateAll((options, end) => options.find(option => option.textContent.trim().endsWith(end))?.value ?? "", suffix);
  await select.selectOption(value);
}
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  const add = page.getByRole("button", { name: "Attach a copy", exact: true });
  await add.waitFor({ timeout: 30000 });
  check("git panel opens", true);
  await add.click();
  await chooseCopy(page, "/alpha");
  await page.getByRole("button", { name: "Attach and open" }).click(); await page.waitForURL(address => !address.pathname.endsWith("/git/projects"), { timeout: 30000 }).catch(() => {}); await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  const entry = page.locator(".git-projects-table").getByRole("button", { name: "alpha", exact: true }).first();
  await entry.waitFor({ timeout: 30000 }).catch(() => {});
  check("copy attached and listed", await entry.count() > 0);
  await entry.click();
  await page.getByRole("tablist", { name: "Project sections" }).getByRole("tab", { name: "CI/CD" }).click();
  const forge = page.getByText("GitHub · github.com/stand-owner/alpha");
  await forge.waitFor({ timeout: 30000 }).catch(() => {});
  check("forge detected from the SSH origin", await forge.count() > 0);
  check("no account connected is stated", await page.getByText("No connected account for https://github.com.").count() > 0);
  await page.screenshot({ path: out + "/smoke-1440.png", fullPage: true });
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  await page.screenshot({ path: out + "/smoke-768.png", fullPage: true });
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
