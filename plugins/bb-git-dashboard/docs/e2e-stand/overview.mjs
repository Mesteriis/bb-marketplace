// Browser probe of the overview (R2), after inbox.mjs (the Gitea and GitLab stand-ins' accounts are connected then):
// the panel opens on it; my pull request with failing CI is under "Needs your action" with its blockers and one main
// action; j/k move the selection and Enter opens the pull request; the board shows the same pull requests by stage and
// stays the view after a reload; nothing scrolls sideways at 768 px. Shots of both views, light and dark, English and
// Russian, go to <outDir>. Usage: node overview.mjs <bbUrl> <toolsDir> <chrome> <outDir>. Last line is PASS or FAIL.
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = (locator, timeout = 15000) => locator.first().waitFor({ timeout }).then(() => true, () => false);
const side = page => page.getByRole("navigation", { name: "Makosh Git" });
let saved = false;
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(url + "plugins/bb-git-dashboard/git", { waitUntil: "load" });
    check(theme + ": the panel opens on the overview", await visible(page.getByRole("heading", { name: "Overview", level: 1 }), 30000)
      && await side(page).getByRole("button", { name: /^Overview\b/ }).getAttribute("aria-current") === "page");
    if (theme === "light" && await page.getByRole("button", { name: "Board", exact: true }).getAttribute("aria-pressed") === "true") {
      await page.getByRole("button", { name: "List", exact: true }).click();
    }
    const action = page.getByRole("listbox", { name: "Needs your action" });
    const failing = action.getByRole("option", { name: /CI failed.*Add greeting check/ });
    check(theme + ": my pull request with failing CI needs my action", await visible(failing, 60000));
    if (theme === "light") {
      check("the status is a word as well as a colour, and the meta line names the repository and number", await visible(failing.getByText("CI failed"))
        && await visible(failing.getByText(/stand\/beta #3/)));
      await failing.click();
      const details = page.getByRole("complementary", { name: "Details" });
      check("its details list what keeps it from merging, with one main action", await visible(details.getByText("What keeps it from merging"))
        && await visible(details.getByText(/CI failing/)) && await details.locator(".g-btn.pri").count() === 1
        && await details.getByRole("button", { name: "Checks" }).count() === 1);
      // Keyboard: from the first item j goes to the second and k back; the focused item is the selected one; Enter opens it.
      const options = page.getByRole("option");
      const keys = await options.evaluateAll(items => items.map(item => item.getAttribute("data-key")));
      await options.first().focus();
      await page.keyboard.press("j");
      const second = await page.evaluate(() => [document.activeElement?.getAttribute("data-key"), document.querySelector("[role=option][aria-selected=true]")?.getAttribute("data-key")]);
      await page.keyboard.press("k");
      const first = await page.evaluate(() => [document.activeElement?.getAttribute("data-key"), document.querySelector("[role=option][aria-selected=true]")?.getAttribute("data-key")]);
      check("j and k move the focus and the selection together", keys.length < 2
        || (second[0] === keys[1] && second[1] === keys[1] && first[0] === keys[0] && first[1] === keys[0]), {keys, second, first});
      await failing.focus();
      await page.keyboard.press("Enter");
      check("Enter opens the focused pull request", await page.waitForURL(/\/git\/pr\/stand-gitea\/3\//, { timeout: 15000 }).then(() => true, () => false), page.url());
      await side(page).getByRole("button", { name: /^Overview\b/ }).click();
      await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
      await page.screenshot({ path: out + "/overview-list-light.png" });
      // Board, kept after a reload.
      await page.getByRole("button", { name: "Board", exact: true }).click();
      check("the board shows the same pull requests by stage, with CI now", await visible(page.getByRole("region", { name: "CI now" }))
        && await visible(page.getByRole("region", { name: "PR open" }).or(page.getByRole("region", { name: "In review" })).getByText("Add greeting check")));
      await page.waitForTimeout(1500);
      await page.reload({ waitUntil: "load" });
      saved = await page.getByRole("button", { name: "Board", exact: true }).waitFor({ timeout: 30000 }).then(async () =>
        await page.getByRole("button", { name: "Board", exact: true }).getAttribute("aria-pressed") === "true", () => false);
      check("the chosen view is kept after a reload", saved);
      await page.getByRole("region", { name: "CI now" }).waitFor({ timeout: 30000 }).catch(() => {});
      await page.screenshot({ path: out + "/overview-board-light.png" });
      // Russian.
      await side(page).getByRole("button", { name: "RU", exact: true }).click();
      await page.getByRole("button", { name: "Список", exact: true }).click();
      check("in Russian the overview's words are Russian", await visible(page.getByRole("heading", { name: "Обзор", level: 1 }))
        && await visible(page.getByRole("listbox", { name: "Нужно ваше действие" })));
      await page.waitForTimeout(800);
      await page.screenshot({ path: out + "/overview-list-ru-light.png" });
      await side(page).getByRole("button", { name: "EN", exact: true }).click();
      await page.waitForTimeout(1500);
      // Narrow: the details go under the list, nothing scrolls sideways.
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ...[...document.querySelectorAll(".git-ws-frame > .git-ws")].map(element => element.scrollWidth - element.clientWidth)));
      check("no horizontal overflow at 768 px", overflow <= 0, overflow);
      await page.screenshot({ path: out + "/overview-768.png" });
    } else {
      await page.screenshot({ path: out + "/overview-list-dark.png" });
      await page.getByRole("button", { name: "Board", exact: true }).click();
      await page.getByRole("region", { name: "CI now" }).waitFor({ timeout: 30000 }).catch(() => {});
      await page.screenshot({ path: out + "/overview-board-dark.png" });
      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.waitForTimeout(1500);
    }
    check(theme + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
