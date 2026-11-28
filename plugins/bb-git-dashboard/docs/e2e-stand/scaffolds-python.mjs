// Browser probe of 0.15.0, after scaffolds.mjs: New project offers django-uv — on Poetry with Celery and GitLab CI it is
// previewed, then made with its files, an executable manage.py, Poetry's CI and one commit by the author — and
// python-service-uv's aiogram bot, made with its router and tests. The scaffolds' own parameters are labelled in Russian
// with the interface in Russian. Shots light, dark and Russian.
// Usage: node scaffolds-python.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND). Last line is PASS or FAIL.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const projects = process.env.STAND + "/home/projects";
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], {encoding: "utf8"}).trim();
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = async (locator, timeout = 30000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };

/** Opens New project in the Catalog and picks a scaffold by its title; gives the page's region and the scaffold's form. */
async function newProject(page, title, formName = "New " + title) {
  await page.goto(url + "plugins/bb-git-dashboard/git/catalog", { waitUntil: "load" });
  const catalog = page.getByRole("region", { name: /^(Catalog|Каталог)$/ });
  await catalog.getByRole("button", { name: /^(New project…|Новый проект…)$/ }).click({ timeout: 60000 });
  const section = page.getByRole("region", { name: /^(New project|Новый проект)$/ });
  await section.locator(".git-np-pick select").selectOption({ label: title }, { timeout: 30000 });
  return {section, form: section.getByRole("form", { name: formName })};
}

try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));

    if (theme === "light") {
      // django-uv on Poetry with Celery and GitLab CI.
      const {section, form} = await newProject(page, "Django site (uv or Poetry)");
      check("django-uv is offered with its parameters, the project package no longer one of them", await visible(form.getByRole("group", { name: "Dependency manager" }))
        && await form.getByLabel("Django project package (settings, URLs)").count() === 0);
      await form.getByLabel("Folder name").fill("legacy-shop");
      await form.getByRole("group", { name: "Dependency manager" }).getByRole("button", { name: "poetry" }).click();
      await form.getByLabel("Celery worker (Redis broker)").check();
      await form.getByRole("group", { name: "CI" }).getByRole("button", { name: "GitLab" }).click();
      await form.getByLabel("Name", { exact: true }).fill("Stand Author");
      await form.getByLabel("Email").fill("author@example.invalid");
      const files = section.getByRole("list", { name: "Files" });
      check("the files: manage.py, the settings, Celery, Poetry's GitLab CI", await visible(files.getByRole("button", { name: ".gitlab-ci.yml" }))
        && await visible(files.getByRole("button", { name: "src/web/manage.py" })) && await visible(files.getByRole("button", { name: "src/web/config/settings.py" }))
        && await visible(files.getByRole("button", { name: "src/web/config/celery.py" })) && await files.getByRole("button", { name: "docker/Dockerfile" }).count() === 0);
      await files.getByRole("button", { name: "src/web/pyproject.toml" }).click();
      // The content is shown with line numbers: each line is looked for by itself.
      const pyproject = await section.getByLabel("Content of src/web/pyproject.toml").innerText();
      check("pyproject.toml is Poetry's, with Django and Celery pinned", pyproject.includes("[tool.poetry]") && pyproject.includes("package-mode = false")
        && pyproject.includes("\"django==6.1.3\"") && pyproject.includes("\"celery[redis]==5.7.0\"") && !pyproject.includes("[tool.uv]"), pyproject.slice(0, 400));
      await files.getByRole("button", { name: ".gitlab-ci.yml" }).click();
      check("the GitLab CI installs with Poetry and runs make check", /poetry install --no-interaction/.test(await section.getByLabel("Content of .gitlab-ci.yml").innerText()));
      await page.screenshot({ path: out + "/scaffolds-django-form-light.png", fullPage: true });
      const root = projects + "/legacy-shop";
      await section.getByRole("button", { name: "Check project…" }).click();
      const dialog = page.getByRole("dialog");
      check("django-uv is previewed before anything is written", await visible(dialog.getByText(/^Django site \(uv or Poetry\) · \d+ files$/))
        && await visible(dialog.getByText("CI · .gitlab-ci.yml (python-gitlab)")) && !existsSync(root));
      await dialog.getByRole("button", { name: "Confirm" }).click();
      check("the catalog says the Django project was made", await visible(page.getByText(/Created .*\/projects\/legacy-shop with its first commit/), 60000));
      check("the Django folder has manage.py (executable), git on main and one commit by the author, nothing left over",
        existsSync(root + "/src/web/manage.py") && (statSync(root + "/src/web/manage.py").mode & 0o111) !== 0 && existsSync(root + "/src/web/config/celery.py")
        && git(root, "branch", "--show-current") === "main" && git(root, "log", "--format=%an <%ae>|%s") === "Stand Author <author@example.invalid>|Initial commit from the Django site (uv or Poetry) scaffold"
        && git(root, "status", "--porcelain") === "", existsSync(root) ? git(root, "log", "--format=%an|%s") : "no folder");
      check("its CI file is Poetry's on GitLab", /pip install poetry==2\.5\.2 && poetry install --no-interaction/.test(readFileSync(root + "/.gitlab-ci.yml", "utf8")));

      // python-service-uv's aiogram bot.
      const bot = await newProject(page, "Python service (uv)");
      await bot.form.getByLabel("Folder name").fill("echo-bot");
      await bot.form.getByRole("group", { name: /^Kind of service/ }).getByRole("button", { name: "aiogram" }).click();
      await bot.form.getByLabel("Name", { exact: true }).fill("Stand Author");
      await bot.form.getByLabel("Email").fill("author@example.invalid");
      const botFiles = bot.section.getByRole("list", { name: "Files" });
      check("the aiogram bot's files: its router and the toolkit's tests", await visible(botFiles.getByRole("button", { name: "src/bot/runtime/bot.py" }))
        && await visible(botFiles.getByRole("button", { name: "src/bot/tests/test_bot.py" })) && await botFiles.getByRole("button", { name: "src/api/api/app.py" }).count() === 0);
      await bot.section.getByRole("button", { name: "Check project…" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
      const botRoot = projects + "/echo-bot";
      check("the bot was made with one commit", await visible(page.getByText(/Created .*\/projects\/echo-bot with its first commit/), 60000)
        && existsSync(botRoot + "/src/bot/runtime/bot.py") && git(botRoot, "log", "--format=%s") === "Initial commit from the Python service (uv) scaffold"
        && /"aiogram==3\.34\.0"/.test(readFileSync(botRoot + "/src/bot/pyproject.toml", "utf8")));
    } else {
      // The same form in dark, then in Russian: the scaffold's own parameters are labelled in the chosen language.
      await newProject(page, "Django site (uv or Poetry)");
      await page.waitForTimeout(400);
      await page.screenshot({ path: out + "/scaffolds-django-form-dark.png", fullPage: true });
      await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: "RU", exact: true }).click({ timeout: 30000 });
      await page.waitForTimeout(500);
      const ru = await newProject(page, "Сайт на Django (uv или Poetry)", "Новый Сайт на Django (uv или Poetry)");
      check("ru: django-uv's title and parameters come in Russian from its template", await visible(ru.form.getByRole("group", { name: "Менеджер зависимостей" }))
        && await visible(ru.form.getByLabel("Воркер Celery (брокер Redis)")));
      await page.screenshot({ path: out + "/scaffolds-django-form-ru-dark.png", fullPage: true });
      const python = await newProject(page, "Сервис на Python (uv)", "Новый Сервис на Python (uv)");
      check("ru: the Python service's parameters too", await visible(python.form.getByLabel("Версия Python").or(python.form.getByRole("group", { name: "Версия Python" })))
        && await visible(python.form.getByRole("group", { name: /^Вид сервиса/ })));
      await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: "EN", exact: true }).click({ timeout: 30000 });
      await page.waitForTimeout(400);
    }
    check(theme + ": no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 1500));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
