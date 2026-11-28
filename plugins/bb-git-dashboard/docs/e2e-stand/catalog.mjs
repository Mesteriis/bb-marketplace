// Browser probe of 0.11: the catalog lists the stand's projects folder (alpha, beta, gamma) and the Gitea and GitLab
// stand-ins' repositories, beta and gamma marked cloned; status of chosen projects; a fetch confirmed and answered
// per project; the open pull requests of a chosen repository; the clone dialog with its categories and preview.
// Usage: node catalog.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND). Last line is PASS or FAIL.
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const until = async (condition, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 300)); } return false; };
const visible = async (locator, timeout = 30000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: /^Catalog\b/ }).click({ timeout: 30000 });
  const catalog = page.getByRole("region", { name: "Catalog" });
  const localList = catalog.getByRole("table", { name: "Local" });
  const row = (table, text) => table.getByRole("row").filter({ hasText: text });
  check("the projects folder's projects are listed", await visible(localList.getByText("alpha", { exact: true }))
    && await visible(localList.getByText("beta", { exact: true })) && await visible(localList.getByText("gamma", { exact: true })));
  check("a project shows its forge remote", await visible(row(localList, "beta").getByText(/stand\/beta$/)));
  // The status of the first projects is read on its own: the branch shows without a click.
  check("the catalog reads the branch of each project when it opens", await until(async () => (await localList.locator(".git-catalog-branch").count()) >= 3)
    && (await row(localList, "alpha").locator(".git-catalog-branch").innerText()) === "main");

  await localList.getByLabel("Choose alpha").check();
  await localList.getByLabel("Choose beta").check();
  await catalog.getByRole("button", { name: "Status", exact: true }).click();
  check("Status answers for each chosen project", await until(async () => !(await catalog.getByRole("button", { name: "Status", exact: true }).isDisabled()))
    && (await row(localList, "alpha").locator(".git-catalog-branch").innerText()) === "main");
  await localList.getByLabel("Choose alpha").uncheck();
  await catalog.getByRole("button", { name: "Fetch", exact: true }).click();
  const dialog = page.getByRole("dialog");
  check("a fetch is confirmed with the projects it touches", await visible(dialog.getByText("Fetch 1 project")) && await visible(dialog.getByText("beta", { exact: true })));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await dialog.waitFor({ state: "detached", timeout: 60000 }).catch(() => {});
  // The Gitea stand-in serves no Git transport: the fetch fails, and the row says so instead of a silent success.
  const fetched = row(localList, "beta").locator(".g-chip.bad");
  check("the fetch answers per project", await visible(fetched, 60000), await row(localList, "beta").innerText().catch(() => ""));
  await page.screenshot({ path: out + "/catalog-local.png", fullPage: false });

  await catalog.getByRole("tablist", { name: "Catalog tables" }).getByRole("tab", { name: /^Remote/ }).click();
  const remote = catalog.getByRole("table", { name: "Remote" });
  check("every account's repositories are listed, the cloned ones with their folder", await visible(row(remote, "stand/beta").getByText("cloned"))
    && await visible(row(remote, "stand/gamma").getByText("cloned"))
    && await visible(row(remote, "stand/delta").getByRole("button", { name: "Clone…" })));
  await remote.getByLabel("Choose stand/beta").check();
  await catalog.getByRole("button", { name: "Open pull requests" }).click();
  const pulls = catalog.getByRole("region", { name: /Open pull requests of the chosen/ });
  check("the open pull requests of a chosen repository are listed, closed ones left out", await visible(pulls.getByRole("button", { name: /#3 / }))
    && await pulls.getByRole("button", { name: /#1 / }).count() === 0, await pulls.innerText().catch(() => ""));
  await page.screenshot({ path: out + "/catalog.png", fullPage: false });

  await row(remote, "stand/delta").getByRole("button", { name: "Clone…" }).click();
  check("the clone asks for a category of the projects folder and a name", await visible(dialog.getByRole("group", { name: "Category in the projects folder" }))
    && await dialog.getByLabel("Folder name").inputValue() === "delta" && await visible(dialog.getByText(/\/projects\/delta$/)));
  await page.screenshot({ path: out + "/catalog-clone.png", fullPage: false });
  await dialog.getByLabel("Folder name").fill("../escape");
  check("a name that would leave the folder is refused", await dialog.getByRole("button", { name: "Clone…" }).isDisabled());
  await dialog.getByLabel("Folder name").fill("delta");
  await dialog.getByRole("button", { name: "Clone…" }).click();
  check("the clone is previewed in the same dialog before anything happens", await visible(dialog.getByText(/projects\/delta$/))
    && await visible(dialog.getByRole("button", { name: "Clone", exact: true })) && await visible(dialog.getByRole("button", { name: "Back" })));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  check("Escape closes the clone dialog", await dialog.count() === 0);

  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 1500));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
