// Browser probe of a copy's page (R3), after projects.mjs attached delta: its head has Fetch, Pull and Push; Push asks in a
// dialog, Escape leaves the origin as it was and Push in the dialog pushes; the sections and the Code views are tabs (no
// History under Code); a file is staged with its checkbox. delta gets a local bare origin inside the stand, so nothing
// leaves the machine. Shots go to <outDir>. Usage: node project.mjs <bbUrl> <toolsDir> <chrome> <outDir>. Last line PASS or FAIL.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, tools, chrome, out] = process.argv.slice(2);
const stand = process.env.STAND;
const { chromium } = createRequire(tools + "/")("playwright-core");
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = (locator, timeout = 15000) => locator.first().waitFor({ timeout }).then(() => true, () => false);
const repo = join(stand, "home/projects/Work/delta");
const bare = join(stand, "home/bare/delta.git");
const git = (...args) => execFileSync("git", ["-c", "user.email=stand@example.invalid", "-c", "user.name=stand", ...args], { encoding: "utf8" }).trim();
mkdirSync(join(stand, "home/bare"), { recursive: true });
git("init", "-q", "--bare", "-b", "main", bare);
git("-C", repo, "remote", "add", "origin", bare);
git("-C", repo, "push", "-q", "-u", "origin", "main");
writeFileSync(join(repo, "notes.txt"), "one\n");
git("-C", repo, "add", "notes.txt");
git("-C", repo, "commit", "-qm", "add notes");
writeFileSync(join(repo, "README.md"), "a\nchanged\n");
const originHead = () => git("--git-dir", bare, "rev-parse", "main");
const before = originHead();

const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
    await page.locator(".git-projects-table").getByRole("button", { name: "delta", exact: true }).click({ timeout: 60000 });
    const sections = page.getByRole("tablist", { name: "Project sections" });
    const views = page.getByRole("tablist", { name: "Code views" });
    check(theme + ": the copy's page opens on Code", await visible(page.getByRole("heading", { name: "delta", level: 1 }), 30000)
      && await sections.getByRole("tab", { name: "Code" }).getAttribute("aria-selected") === "true");
    if (theme === "light") {
      check("the sections are six tabs", (await sections.getByRole("tab").allInnerTexts()).map(text => text.replace(/\s*\d+$/, "")).join("|") === "Code|History|Review|CI/CD|Issues|Variables",
        await sections.getByRole("tab").allInnerTexts());
      check("Code has Changes, Branches, Worktrees and Activity, without History", await views.getByRole("tab").count() === 4
        && await views.getByRole("tab", { name: /^History/ }).count() === 0);
      const stage = page.getByRole("checkbox", { name: "Stage README.md" });
      check("a changed file is listed as not staged, with its checkbox", await visible(stage, 30000));
      await stage.click();
      check("its checkbox stages it", await visible(page.getByRole("checkbox", { name: "Unstage README.md" }), 30000));
      await page.screenshot({ path: out + "/project-code-light.png" });
      // Push asks first.
      const push = page.getByRole("button", { name: /^Push/ });
      await visible(page.getByRole("button", { name: "Push 1" }), 30000);
      await push.click();
      const dialog = page.getByRole("dialog", { name: "Push to origin?" });
      check("Push asks in a dialog what it will push where", await visible(dialog) && await visible(dialog.getByText("origin/main")));
      const box = await dialog.boundingBox();
      check("the dialog stands in the middle of the window", !!box && Math.abs(box.x + box.width / 2 - 720) < 40 && Math.abs(box.y + box.height / 2 - 512) < 80, box);
      await page.screenshot({ path: out + "/project-push-light.png" });
      await page.keyboard.press("Escape");
      check("Escape closes the dialog and pushes nothing", await dialog.count() === 0 && originHead() === before && await visible(page.getByRole("heading", { name: "delta", level: 1 })));
      await push.click();
      await dialog.getByRole("button", { name: "Push" }).click();
      await dialog.waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
      check("Push in the dialog pushes the branch to its origin", originHead() === git("-C", repo, "rev-parse", "HEAD"), [originHead(), before]);
      for (const name of ["Branches", "Worktrees", "Activity"]) {
        await views.getByRole("tab", { name: new RegExp("^" + name) }).click();
        await page.waitForTimeout(1200);
        await page.screenshot({ path: out + "/project-" + name.toLowerCase() + "-light.png" });
        if (name === "Branches") {
          check("the branches are a table with what each tracks and its last commit", await visible(page.getByRole("table", { name: "Branches" }).locator("tr[data-branch=\"main\"]").getByText("origin/main")));
          await page.getByRole("button", { name: "+ Create branch" }).click();
          const create = page.getByRole("dialog", { name: "Create a branch" });
          check("Create branch asks in a dialog", await visible(create));
          await page.screenshot({ path: out + "/project-create-branch-light.png" });
          await page.keyboard.press("Escape");
        }
      }
      check("the Activity says the push in words, with its result", await visible(page.locator(".git-activity-list li", { hasText: "Push" }).getByText("done"), 15000));
      // Russian.
      await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: "RU", exact: true }).click();
      check("in Russian the tabs are Russian", await visible(page.getByRole("tablist", { name: "Разделы проекта" }).getByRole("tab", { name: /^Код/ }))
        && await visible(page.getByRole("tablist", { name: "Виды кода" }).getByRole("tab", { name: /^Изменения/ })));
      await page.getByRole("tablist", { name: "Виды кода" }).getByRole("tab", { name: /^Изменения/ }).click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: out + "/project-code-ru-light.png" });
      await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: "EN", exact: true }).click();
      // Issues of a copy whose forge has them.
      await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
      await page.locator(".git-projects-table").getByRole("button", { name: "gamma", exact: true }).click({ timeout: 60000 });
      await sections.getByRole("tab", { name: "Issues" }).click();
      await page.getByRole("button", { name: /#4 / }).first().waitFor({ timeout: 30000 }).catch(() => {});
      await page.screenshot({ path: out + "/project-issues-light.png" });
    } else {
      await page.getByText("README.md").first().waitFor({ timeout: 30000 }).catch(() => {});
      await page.screenshot({ path: out + "/project-code-dark.png" });
      for (const name of ["Branches", "Worktrees", "Activity"]) {
        await views.getByRole("tab", { name: new RegExp("^" + name) }).click();
        await page.waitForTimeout(1200);
        await page.screenshot({ path: out + "/project-" + name.toLowerCase() + "-dark.png" });
        if (name === "Branches") {
          await page.getByRole("button", { name: "+ Create branch" }).click();
          await page.getByRole("dialog", { name: "Create a branch" }).waitFor({ timeout: 10000 }).catch(() => {});
          await page.screenshot({ path: out + "/project-create-branch-dark.png" });
          await page.keyboard.press("Escape");
        }
      }
      await views.getByRole("tab", { name: /^Changes/ }).click();
      await page.getByRole("button", { name: /^Push/ }).click();
      await page.getByRole("dialog", { name: "Push to origin?" }).waitFor({ timeout: 10000 }).catch(() => {});
      await page.screenshot({ path: out + "/project-push-dark.png" });
      await page.keyboard.press("Escape");
    }
    check(theme + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 300));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
