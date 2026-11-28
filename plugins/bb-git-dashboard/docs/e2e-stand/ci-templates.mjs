// Browser probe of CI templates against the stand's Gitea stand-in, after ci.mjs (which attaches stand-beta): the
// stack read at HEAD, the suited template first, a value that does not fit refused before anything is sent, the
// file previewed, then the file in a new branch and its pull request through the confirmation dialog, each reaching
// the stand-in once. Last line is PASS or FAIL.
// Usage: node ci-templates.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND = stand directory)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const writes = () => readFileSync(process.env.STAND + "/forge/writes.log", "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const { chromium } = createRequire(tools + "/")("playwright-core");
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const until = async (condition, timeout = 10000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 250)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };

// A Node project with pnpm, committed: the stack is read from HEAD, not from the working copy.
const beta = process.env.STAND + "/home/projects/beta";
writeFileSync(beta + "/package.json", JSON.stringify({name: "beta", packageManager: "pnpm@9.12.0", scripts: {test: "node --test"}}) + "\n");
writeFileSync(beta + "/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
execFileSync("git", ["-C", beta, "add", "--", "package.json", "pnpm-lock.yaml"]);
execFileSync("git", ["-C", beta, "-c", "user.email=stand@example.invalid", "-c", "user.name=stand", "commit", "-qm", "Node project", "--", "package.json", "pnpm-lock.yaml"]);
const before = writes().length;

const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  const entry = page.locator(".git-projects-table").getByRole("button", { name: "beta", exact: true }).first();
  check("the attached copy is listed", await visible(entry, 30000));
  await entry.click();
  await page.getByRole("tablist", { name: "Project sections" }).getByRole("tab", { name: "CI/CD" }).click();
  await page.getByRole("button", { name: "Templates", exact: true }).click({ timeout: 20000 });
  const section = page.getByRole("region", { name: "CI templates" });
  check("the stack is read at HEAD with its evidence", await visible(section.getByText("Found at HEAD: Node.js (package.json, pnpm-lock.yaml).")));
  check("the forge's templates are offered", await visible(section.getByText("CI templates · Gitea Actions")));
  // The templates are a list: the suited one is marked "fits" and chosen first.
  const list = section.getByRole("navigation", { name: "Templates" });
  const chosen = list.locator("button[aria-current=true]");
  check("the suited template is chosen first and marked as fitting", await visible(chosen) && /^Node\.js\s*fits$/.test((await chosen.innerText()).trim()),
    await chosen.innerText().catch(() => ""));
  check("the list, the form and the preview stand side by side", await section.evaluate(element => {
    const boxes = [".git-ci-tpl-list", ".git-ci-tpl-form", ".git-ci-tpl-preview"].map(selector => element.querySelector(selector)?.getBoundingClientRect());
    return boxes.every(Boolean) && boxes[0].right <= boxes[1].left + 1 && boxes[1].right <= boxes[2].left + 1;
  }));
  check("the preview numbers its lines and counts them", await visible(section.locator(".git-ci-tpl-code .git-ci-number").first()) && await visible(section.getByText(/^\d+ lines$/)));
  const preview = section.getByLabel("File preview");
  const text = await preview.innerText();
  check("the preview takes pnpm and the test script from the project", /run: pnpm install --frozen-lockfile/.test(text) && /run: pnpm run test/.test(text)
    && !/pnpm run build/.test(text), text.slice(0, 600));
  check("the file goes to .gitea/workflows", await visible(section.getByText(".gitea/workflows/ci.yml", { exact: true })));
  await page.screenshot({ path: out + "/project-ci-templates-light.png" });

  const version = section.getByLabel("Node.js version");
  await version.fill("22: x");
  check("a value that does not fit is refused before anything is sent", await visible(section.getByText(/Check the values: value of nodeVersion does not fit/))
    && await section.getByRole("button", { name: "Create branch and pull request" }).isDisabled());
  await version.fill("20");
  check("the preview follows the values", await until(async () => /node-version: "20"/.test(await preview.innerText())));

  await section.getByRole("button", { name: "Create branch and pull request" }).click();
  const dialog = page.getByRole("dialog");
  check("the new branch and pull request are previewed first, nothing sent", await visible(dialog.getByText("New branch · ci/node-gitea"))
    && await visible(dialog.getByText(/^stand\/beta:main @ a{40}$/)) && writes().length === before);
  check("the dialog shows the file to commit", /node-version: "20"/.test(await dialog.getByLabel("File to commit").innerText()));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  check("the pull request is reported", await visible(section.getByText("Pull request #9 opened for ci/node-gitea.")), await section.getByRole("alert").allInnerTexts());
  const sent = writes().slice(before);
  const [file, pull] = sent;
  check("the file and the pull request reached the forge once each", sent.length === 2 && file?.path === "/api/v1/repos/stand/beta/contents/.gitea/workflows/ci.yml"
    && pull?.path === "/api/v1/repos/stand/beta/pulls", sent.map(write => write.path));
  check("the file went into a new branch from main", file?.body.branch === "main" && file?.body.new_branch === "ci/node-gitea"
    && /node-version: "20"/.test(Buffer.from(file?.body.content ?? "", "base64").toString("utf8")), file?.body && {...file.body, content: undefined});
  check("the pull request is from the new branch to main", pull?.body.head === "ci/node-gitea" && pull?.body.base === "main" && pull?.body.title === "Add CI: Node.js · Gitea Actions", pull?.body);

  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  await page.screenshot({ path: out + "/ci-templates-768.png", fullPage: true });
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 1500));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
