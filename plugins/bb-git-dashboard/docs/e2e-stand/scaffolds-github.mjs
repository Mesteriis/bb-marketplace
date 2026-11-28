// Browser probe of 0.16.1: the templates come from the templates repository on the stand-in GitHub. New project shows
// the revision; opening it again within a minute and Refresh ask with the ETag (a 304); a new head is read on Refresh;
// a preview made on one revision is not created after the templates moved on; a broken archive, no network and
// GitHub's limit keep the revision held and say why; no token is sent (the stand has no GitHub account) and the proxy
// saw no host but api.github.com and codeload.github.com.
// Usage: node scaffolds-github.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND). Last line is PASS or FAIL.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, tools, chrome, out] = process.argv.slice(2);
const stand = process.env.STAND;
const facts = Object.fromEntries(readFileSync(join(stand, "facts.env"), "utf8").trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
const control = (path, method = "POST") => fetch(facts.GITHUB_CONTROL + path, {method}).then(response => response.json());
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = async (locator, timeout = 30000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };

async function open(page) {
  await page.goto(url + "plugins/bb-git-dashboard/git/catalog", { waitUntil: "load" });
  await page.getByRole("region", { name: "Catalog" }).getByRole("button", { name: "New project…" }).click({ timeout: 60000 });
  const section = page.getByRole("region", { name: "New project" });
  await section.getByRole("status", { name: "Templates" }).waitFor({ timeout: 60000 });
  return section;
}
const line = section => section.getByRole("status", { name: "Templates" });
const branchAsks = async () => (await control("/requests", "GET")).filter(item => item.path === "/repos/stand/templates/branches/main");

try {
  const first = (await control("/state", "GET")).head;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  let section = await open(page);
  check("the form names the templates repository and its revision", await visible(line(section).getByText("stand/templates@" + first.slice(0, 7), { exact: false })),
    await line(section).innerText());
  check("the repository's templates are offered", await visible(section.getByRole("form", { name: "New Python service (uv)" })));
  await page.screenshot({ path: out + "/scaffolds-github-form.png", fullPage: true });

  const before = (await branchAsks()).length;
  await section.getByRole("button", { name: "Refresh templates" }).click();
  await page.waitForTimeout(1500);
  const asks = await branchAsks();
  check("Refresh asks again with the ETag of the last answer", asks.length === before + 1 && asks.at(-1).ifNoneMatch === "W/\"" + first + "\"", asks.at(-1));

  // A preview on this revision, then the templates move on in another tab: Create refuses, nothing is written.
  const form = section.getByRole("form", { name: "New Python service (uv)" });
  await form.getByLabel("Folder name").fill("pinned-service");
  await form.getByLabel("Name", { exact: true }).fill("Stand Author");
  await form.getByLabel("Email").fill("author@example.invalid");
  await section.getByRole("button", { name: "Check project…" }).click();
  const dialog = page.getByRole("dialog");
  check("the preview names the revision it is made from", await visible(dialog.getByText("Templates stand/templates@" + first.slice(0, 7) + " (main)")));
  const second = (await control("/advance")).head;
  const other = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const otherSection = await open(other);
  await otherSection.getByRole("button", { name: "Refresh templates" }).click();
  check("Refresh reads the new head", await visible(line(otherSection).getByText("stand/templates@" + second.slice(0, 7), { exact: false })), await line(otherSection).innerText());
  await other.close();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  check("a preview of the old revision is not created after the templates moved on", await visible(section.getByRole("alert").filter({ hasText: /new revision/ }))
    && !existsSync(stand + "/home/projects/pinned-service"), await section.getByRole("alert").allInnerTexts());

  // A broken archive: the revision held stays, and the form says why.
  section = await open(page);
  await control("/broken");
  await section.getByRole("button", { name: "Refresh templates" }).click();
  check("a broken archive keeps the revision held and says why", await visible(section.getByText(/Not refreshed: the archive is not gzip/))
    && await visible(line(section).getByText("stand/templates@" + second.slice(0, 7), { exact: false })));
  await page.screenshot({ path: out + "/scaffolds-github-broken.png", fullPage: true });

  await control("/mode/offline");
  await section.getByRole("button", { name: "Refresh templates" }).click();
  check("without the network the held templates are still offered, with the reason", await visible(section.getByText(/Not refreshed: GitHub could not be reached/))
    && await visible(section.getByRole("form", { name: "New Python service (uv)" })));
  await control("/mode/limited");
  await section.getByRole("button", { name: "Refresh templates" }).click();
  check("GitHub's limit is said as such; with no GitHub account no token is tried", await visible(section.getByText(/Not refreshed: GitHub's request limit for this machine is reached/)));
  await control("/mode/normal");

  const seen = await control("/requests", "GET");
  check("no request carried a token", seen.every(item => item.auth !== true), seen.filter(item => item.auth));
  const refused = seen.filter(item => item.proxy === "refused" && !item.offline);
  check("the proxy saw no other host than api.github.com and codeload.github.com", refused.length === 0, refused);
  check("the archive came from codeload.github.com", seen.some(item => item.host === "codeload.github.com"));
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 1500));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
