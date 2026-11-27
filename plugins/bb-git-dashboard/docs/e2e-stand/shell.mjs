// Browser probe of the side column (R1): every section is reached from it with the keyboard, "/" puts the cursor in the
// search, the language switch changes the column's strings and survives a reload, nothing scrolls sideways at 768 px.
// Shots of every section in the new frame, light and dark (BB's own switch: localStorage "bb.theme"), go to <outDir>.
// Usage: node shell.mjs <bbUrl> <toolsDir> <chrome> <outDir>. Last line is PASS or FAIL.
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = (locator, timeout = 15000) => locator.first().waitFor({ timeout }).then(() => true, () => false);
const named = label => new RegExp("^" + label.replace(/[/]/g, "\\/") + "\\b");
const sections = [["Projects", "projects"], ["My PRs", "inbox"], ["CI/CD", "ci"], ["Reviews", "reviews"], ["Catalog", "catalog"], ["Connections", "connections"]];
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(url + "plugins/bb-git-dashboard/git", { waitUntil: "load" });
    const side = page.getByRole("navigation", { name: "Makosh Git" });
    check(theme + ": the side column is there", await visible(side, 30000));
    check(theme + ": BB is in the " + theme + " mode", await page.evaluate(() => document.documentElement.classList.contains("dark")) === (theme === "dark"));
    if (theme === "light") {
      // English by BB's language on this browser; Russian from the switch, kept after a reload.
      check("the column follows BB's language (English here)", await visible(side.getByRole("button", { name: "Catalog", exact: true })));
      await side.getByRole("button", { name: "RU", exact: true }).click();
      check("the switch turns the column Russian at once", await visible(side.getByRole("button", { name: "Каталог", exact: true })));
      // The choice is saved through the plugin's RPC; a reload after it has gone through keeps it.
      let kept = false;
      for (let attempt = 0; attempt < 5 && !kept; attempt++) {
        await page.waitForTimeout(1000);
        await page.reload({ waitUntil: "load" });
        kept = await visible(page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: "Каталог", exact: true }), 15000);
      }
      check("and the choice survives a reload", kept);
      await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: "EN", exact: true }).click();
      check("back to English", await visible(side.getByRole("button", { name: "Catalog", exact: true })));
      await page.locator("body").click({ position: { x: 900, y: 600 } });
      await page.keyboard.press("/");
      check("\"/\" puts the cursor in the search", await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === "Find a project");
      // Keyboard: Tab reaches a section, Enter opens it.
      const catalog = side.getByRole("button", { name: "Catalog", exact: true });
      await catalog.focus();
      await page.keyboard.press("Enter");
      check("a section opens from the keyboard and is marked current", await visible(page.getByRole("heading", { name: "Catalog" }))
        && await catalog.getAttribute("aria-current") === "page");
    }
    for (const [label, name] of sections) {
      await side.getByRole("button", { name: named(label) }).click();
      await page.waitForTimeout(700);
      check(theme + ": " + label + " is current", await side.getByRole("button", { name: named(label) }).getAttribute("aria-current") === "page");
      await page.screenshot({ path: out + "/shell-" + name + "-" + theme + ".png" });
    }
    if (theme === "light") {
      // A dialog keeps the focus inside, closes on Escape and gives the focus back to the button that opened it.
      const add = page.getByRole("button", { name: "+ Add connection" });
      await add.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 10000 });
      let inside = true;
      for (let step = 0; step < 25; step++) {
        await page.keyboard.press("Tab");
        inside = inside && await page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")));
      }
      check("Tab stays inside the dialog", inside);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      check("Escape closes the dialog and the focus is back on its button", await dialog.count() === 0
        && await page.evaluate(() => document.activeElement?.textContent?.trim()) === "+ Add connection",
        await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)));
      await page.setViewportSize({ width: 768, height: 1024 });
      for (const [label] of sections) {
        await side.getByRole("button", { name: named(label) }).click();
        await page.waitForTimeout(500);
        // Neither the page nor the plugin's own scrolling frame scrolls sideways (tables scroll inside themselves).
        const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ...[...document.querySelectorAll(".git-ws-frame > .git-ws, .git-ws.g-side")].map(element => element.scrollWidth - element.clientWidth)));
        check("no horizontal overflow at 768 px: " + label, overflow <= 0, overflow);
      }
      await page.screenshot({ path: out + "/shell-768.png" });
    }
    check(theme + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
  // The language is a saved setting: leave the stand in English for the probes after this one.
  const page = await browser.newPage();
  await page.goto(url + "plugins/bb-git-dashboard/git", { waitUntil: "load" }).catch(() => {});
  await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: "EN", exact: true }).click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
