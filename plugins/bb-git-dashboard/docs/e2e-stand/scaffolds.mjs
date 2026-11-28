// Browser probe of 0.13.0 (0.16.1: the templates come from the stand-in GitHub's templates repository): New project in
// the Catalog — a Python scaffold with free text, GitHub Actions CI and an author; a name that is no folder name refused in the form; the preview before anything is written; then the folder
// in the projects folder with its files, git init on main and one commit by the author, listed in the catalog; the
// same name again refused. Usage: node scaffolds.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND). Last line is PASS or FAIL.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const project = process.env.STAND + "/home/projects/notes-service";
const git = (...args) => execFileSync("git", ["-C", project, ...args], {encoding: "utf8"}).trim();
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = async (locator, timeout = 30000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: /^Catalog\b/ }).click({ timeout: 30000 });
  const catalog = page.getByRole("region", { name: "Catalog" });
  await catalog.getByRole("button", { name: "New project…" }).click({ timeout: 60000 });
  const section = page.getByRole("region", { name: "New project" });
  const form = section.getByRole("form", { name: "New Python service (uv)" });
  check("the scaffolds are offered, the Python service first", await visible(form));
  await form.getByLabel("Folder name").fill("My App");
  check("a name that is no folder name is refused before anything is sent", await visible(section.getByText(/the project name must be a folder name/))
    && await section.getByRole("button", { name: "Check project…" }).isDisabled());
  await form.getByLabel("Folder name").fill("notes-service");
  await form.getByLabel("One-line description").fill("Notes \"service\" for: everyone");
  await form.getByRole("group", { name: /^Kind of service/ }).getByRole("button", { name: "fastapi" }).click();
  await form.getByLabel("Name", { exact: true }).fill("Stand Author");
  await form.getByLabel("Email").fill("author@example.invalid");
  const files = section.getByRole("list", { name: "Files" });
  check("the files include the common ones, the service and the CI file", await visible(files.getByRole("button", { name: ".github/workflows/ci.yml" }))
    && await visible(files.getByRole("button", { name: "LICENSE" })) && await visible(files.getByRole("button", { name: "src/api/api/app.py" })));
  await files.getByRole("button", { name: "src/api/pyproject.toml" }).click();
  check("free text is escaped in pyproject.toml", (await section.getByLabel("Content of src/api/pyproject.toml").innerText()).includes("description = \"Notes \\\"service\\\" for: everyone\""));
  await page.screenshot({ path: out + "/scaffolds-form.png", fullPage: true });

  await section.getByRole("button", { name: "Check project…" }).click();
  const dialog = page.getByRole("dialog");
  check("the project is previewed before anything is written", await visible(dialog.getByText(/^Python service \(uv\) · \d+ files$/))
    && await visible(dialog.getByText("CI · .github/workflows/ci.yml (python-github)")) && await visible(dialog.getByText(/first commit by Stand Author <author@example\.invalid>/))
    && !existsSync(project));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  check("the catalog says the project was made", await visible(page.getByText(/Created .*\/projects\/notes-service with its first commit/)));
  check("the folder has its files, git on main and one commit by the author", existsSync(project + "/src/api/pyproject.toml") && existsSync(project + "/src/api/api/app.py")
    && git("branch", "--show-current") === "main" && git("log", "--format=%an <%ae>|%s") === "Stand Author <author@example.invalid>|Initial commit from the Python service (uv) scaffold"
    && git("status", "--porcelain") === "");
  const workflow = readFileSync(project + "/.github/workflows/ci.yml", "utf8");
  check("the CI file installs with uv in src/api and runs make check at the root", /run: pip install uv==0\.13\.10 && uv sync\n {8}working-directory: src\/api\n/.test(workflow) && /run: make check\n$/.test(workflow), workflow.slice(-200));
  // The common files are the templates repository's own common/, byte for byte where nothing is filled in.
  const common = process.env.SCAFFOLDS_REPO + "/common/files/";
  check("the project's common files are the templates repository's", readFileSync(project + "/docs/adr/README.md", "utf8") === readFileSync(common + "docs/adr/README.md", "utf8")
    && readFileSync(project + "/SECURITY.md", "utf8") === readFileSync(common + "SECURITY.md", "utf8"));
  check("the new project is listed in the catalog", await visible(catalog.getByRole("table", { name: "Local" }).getByText("notes-service", { exact: true }), 60000));

  await catalog.getByRole("button", { name: "New project…" }).click();
  const again = page.getByRole("region", { name: "New project" }).getByRole("form", { name: "New Python service (uv)" });
  await again.getByLabel("Folder name").fill("notes-service");
  await again.getByLabel("Name", { exact: true }).fill("Stand Author");
  await again.getByLabel("Email").fill("author@example.invalid");
  await page.getByRole("region", { name: "New project" }).getByRole("button", { name: "Check project…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  check("the same name again is refused in the form and nothing is overwritten", await visible(page.getByRole("region", { name: "New project" }).getByRole("alert").filter({hasText: "DESTINATION_EXISTS"}))
    && await page.getByRole("dialog").count() === 0 && git("log", "--format=%s").split("\n").length === 1);

  // 0.13.1: a repository on the Gitea stand-in, private by default, and the first push to it.
  await page.getByRole("button", { name: "Back to the catalog" }).click();
  await catalog.getByRole("button", { name: "New project…" }).click();
  const pushedForm = page.getByRole("region", { name: "New project" }).getByRole("form", { name: "New Python service (uv)" });
  await pushedForm.getByLabel("Folder name").fill("pushed-service");
  await pushedForm.getByLabel("Name", { exact: true }).fill("Stand Author");
  await pushedForm.getByLabel("Email").fill("author@example.invalid");
  await pushedForm.getByLabel("Create a repository on a forge and push main").check();
  await pushedForm.getByLabel("Account").selectOption({ label: "stand (gitea)" });
  const visibility = pushedForm.getByRole("group", { name: "Visibility" });
  check("a new repository is private unless chosen otherwise, and public is warned about", await visibility.getByRole("button", { name: "Private" }).getAttribute("aria-pressed") === "true"
    && await pushedForm.getByText("Public: anyone can read").count() === 0);
  await visibility.getByRole("button", { name: "Public" }).click();
  check("public is spelled out before anything is sent", await visible(pushedForm.getByText("Public: anyone can read the repository and its history.")));
  await visibility.getByRole("button", { name: "Private" }).click();
  const writesBefore = readFileSync(process.env.STAND + "/forge/writes.log", "utf8").split("\n").filter(Boolean).length;
  await page.getByRole("region", { name: "New project" }).getByRole("button", { name: "Check project…" }).click();
  const pushDialog = page.getByRole("dialog");
  check("the preview names the account, the repository and its visibility, and says the token goes into the Keychain for its address",
    await visible(pushDialog.getByText(/^New repository · stand \(gitea\) · stand\/pushed-service · private · the token of stand is saved in the Keychain for the new repository's address only, then main is pushed/)));
  await pushDialog.getByRole("button", { name: "Confirm" }).click();
  check("the repository was made and main pushed, with nothing left to do", await visible(page.getByText(/Repository stand\/pushed-service has main\./), 60000)
    && await catalog.locator(".g-banner.warn, .g-banner.bad").count() === 0, await catalog.locator(".g-banner.warn, .g-banner.bad").allInnerTexts());
  const pushedRoot = process.env.STAND + "/home/projects/pushed-service";
  const pushedGit = (...args) => execFileSync("git", ["-C", pushedRoot, ...args], {encoding: "utf8"}).trim();
  const bare = process.env.STAND + "/forge/git/stand/pushed-service.git";
  check("the forge has main at the local head", execFileSync("git", ["-C", bare, "rev-parse", "main"], {encoding: "utf8"}).trim() === pushedGit("rev-parse", "HEAD"));
  check("origin is the plain clone address and main follows it; no credential in the config", /^https:\/\/localhost:\d+\/stand\/pushed-service\.git$/.test(pushedGit("remote", "get-url", "origin"))
    && pushedGit("rev-parse", "--abbrev-ref", "main@{upstream}") === "origin/main" && !/@|token|password/i.test(readFileSync(pushedRoot + "/.git/config", "utf8")));
  // 0.13.2: the plugin handed the token to the credential helper for this repository's path and the account's user, and the
  // push found it there (the Gitea stand-in refuses the new repository without it). On the stand the helper is run.sh's
  // file-backed stand-in, never a Keychain: reading one from here would ask on the desktop.
  const port = new URL(pushedGit("remote", "get-url", "origin")).port;
  const helper = readFileSync(process.env.STAND + "/forge/credentials.log", "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const exact = "https|localhost:" + port + "|stand/pushed-service.git|stand";
  const stores = helper.filter(entry => entry.action === "store");
  check("the account's token was stored for the new repository's exact address and the account's user, and for nothing else", stores.length >= 1
    && stores.every(entry => entry.key === exact && entry.fields.password === "stand-token"), stores.map(entry => entry.key));
  check("the push asked the helper for exactly that address, and nothing was erased", helper.some(entry => entry.action === "get" && entry.key === exact)
    && !helper.some(entry => entry.action === "erase"));
  const created = readFileSync(process.env.STAND + "/forge/writes.log", "utf8").split("\n").filter(Boolean).slice(writesBefore).map(line => JSON.parse(line));
  check("the repository was asked for once, private", created.length === 1 && created[0].path === "/api/v1/user/repos" && created[0].body.private === true
    && created[0].body.name === "pushed-service", created);

  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  await page.screenshot({ path: out + "/scaffolds-768.png", fullPage: true });
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 1500));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
