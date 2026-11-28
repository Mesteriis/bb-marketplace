// Browser probe of the catalog, connections and settings screens in light and dark, English and Russian, after
// catalog.mjs and scaffolds.mjs: the catalog's two tables, the clone dialog (closed, nothing cloned), New project, the
// Connections page with an account check, the connection wizard's first and last step (the check only reads; nothing is
// saved), and the plugin's settings section, where the overview's view is switched and put back. Puts the language back
// to English at the end.
// Usage: node catalog-shots.mjs <bbUrl> <toolsDir> <chrome> <outDir>. Last line is PASS or FAIL.
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
const until = async (condition, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 300)); } return false; };
const side = page => page.getByRole("navigation", { name: "Makosh Git" });
const words = {
  en: {catalog: "Catalog", remote: /^Remote/, local: /^Local/, clone: "Clone…", newProject: "New project…", connections: "Connections", connect: "Connect account",
    check: "Check", works: "Works", next: "Next", checkAccess: "Check access", token: "Personal access token", gitea: /^Gitea/, address: "Address of any repository — the type is found from it",
    access: "Access checked", board: "Board", list: "List", overview: "Overview opens as", tabs: "Catalog tables"},
  ru: {catalog: "Каталог", remote: /^Удалённые/, local: /^Локальные/, clone: "Клонировать…", newProject: "Новый проект…", connections: "Подключения", connect: "Подключить аккаунт",
    check: "Проверить", works: "Работает", next: "Дальше", checkAccess: "Проверить доступ", token: "Токен доступа", gitea: /^Gitea/, address: "Адрес любого репозитория — тип определится сам",
    access: "Доступ проверен", board: "Доской", list: "Списком", overview: "Обзор открывается", tabs: "Таблицы каталога"},
};
try {
  for (const [theme, language] of [["light", "en"], ["dark", "en"], ["light", "ru"]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    const w = words[language];
    const tag = (language === "ru" ? "ru-" : "") + theme;
    const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: out + "/" + name + "-" + tag + ".png" }); };
    await page.goto(url + "plugins/bb-git-dashboard/git/catalog", { waitUntil: "load" });
    await side(page).getByRole("button", { name: language.toUpperCase(), exact: true }).click({ timeout: 30000 });
    const catalog = page.getByRole("region", { name: w.catalog });
    const tabs = catalog.getByRole("tablist", { name: w.tabs });
    check(tag + ": Catalog shows the local projects as a table with their branch", await visible(catalog.locator(".git-catalog-table tbody tr"), 30000)
      && await until(async () => await catalog.locator(".git-catalog-branch").count() > 0));
    await shot("catalog-local");
    await tabs.getByRole("tab", { name: w.remote }).click();
    check(tag + ": the remote tab is a table of the accounts' repositories", await visible(catalog.getByRole("button", { name: w.clone })));
    await shot("catalog");
    await catalog.getByRole("button", { name: w.clone }).first().click();
    const dialog = page.getByRole("dialog");
    check(tag + ": the clone dialog says where the clone goes", await visible(dialog.locator(".git-clone-where .g-mono")));
    await shot("catalog-clone");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await tabs.getByRole("tab", { name: w.local }).click();
    await catalog.getByRole("button", { name: w.newProject }).click();
    const fresh = page.locator(".git-new-project");
    check(tag + ": New project has the form, the files and the chosen file's text", await visible(fresh.locator(".git-np-form"), 30000)
      && await visible(fresh.locator(".git-np-files li")) && await visible(fresh.locator(".git-np-line")));
    await shot("new-project");

    await side(page).getByRole("button", { name: new RegExp("^" + w.connections) }).click();
    const connections = page.locator(".git-connections");
    const accountRow = connections.locator(".git-connection-row").filter({ hasText: "Gitea" }).first();
    check(tag + ": Connections lists the accounts and the servers of the projects folder", await visible(accountRow, 30000)
      && await visible(connections.locator(".git-connection-hosts tbody tr")));
    await accountRow.getByRole("button", { name: w.check, exact: true }).click();
    check(tag + ": Check signs in with the stored token and says what it found", await visible(accountRow.locator(".g-chip"), 30000), await accountRow.innerText().catch(() => ""));
    await shot("connections");
    const host = (await accountRow.locator(".git-connection-text .g-muted").first().innerText()).split("/")[0].trim();
    await connections.getByRole("button", { name: w.connect }).click();
    await dialog.getByLabel(w.address).fill("https://" + host + "/stand/beta");
    await dialog.getByRole("radio", { name: w.gitea }).click();
    check(tag + ": the wizard's first step: an address and the server types", await dialog.getByRole("radio", { name: w.gitea }).getAttribute("aria-checked") === "true");
    await shot("connect-type");
    await dialog.getByRole("button", { name: w.next }).click();
    await dialog.getByLabel(w.token).fill("stand-token");
    await dialog.getByRole("button", { name: w.checkAccess }).click();
    check(tag + ": the last step says the access was checked", await visible(dialog.getByText(w.access), 30000), await dialog.innerText().catch(() => ""));
    await shot("connect-verify");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

    await page.goto(url + "settings/plugins/bb-git-dashboard", { waitUntil: "load" });
    const settings = page.locator(".git-set");
    check(tag + ": the settings section shows the main settings in groups", await visible(settings.locator("section"), 30000) && await settings.locator("section").count() === 5);
    // BB renders its own list of the plugin's settings first; the section follows it.
    await settings.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector(".git-set")?.scrollIntoView({ block: "start" }));
    await shot("settings");
    if (theme === "light" && language === "en") {
      const overview = settings.getByRole("group", { name: w.overview });
      await overview.getByRole("button", { name: w.board }).click();
      const saved = await until(async () => await overview.getByRole("button", { name: w.board }).getAttribute("aria-pressed") === "true");
      await overview.getByRole("button", { name: w.list }).click();
      const back = await until(async () => await overview.getByRole("button", { name: w.list }).getAttribute("aria-pressed") === "true");
      check("a setting written in the section is saved and shown, and put back", saved && back);
    }
    if (language !== "en") {
      await page.goto(url + "plugins/bb-git-dashboard/git/catalog", { waitUntil: "load" });
      await side(page).getByRole("button", { name: "EN", exact: true }).click({ timeout: 30000 });
      await page.waitForTimeout(400);
    }
    check(tag + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 600));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
