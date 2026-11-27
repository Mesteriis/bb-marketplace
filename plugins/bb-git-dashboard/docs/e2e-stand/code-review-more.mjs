// Browser probe of the line review's 0.9.2 behaviour on stand-gamma (attached here): a clean branch opens on its
// commits, a picked view and Side by side survive a reload, an edit on disk shows without Reload (the host's watch),
// 30 untracked files read in batches, a large change starts folded, Clear review. Last line is PASS or FAIL.
// Usage: node code-review-more.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, tools, chrome, out] = process.argv.slice(2);
const stand = process.env.STAND;
const repo = join(stand, "home/projects/gamma");
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.email=stand@example.invalid", "-c", "user.name=stand", ...args], { encoding: "utf8" });
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const until = async (condition, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 300)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  // A feature branch with one commit and a clean tree: nothing uncommitted.
  git("switch", "-q", "-c", "feature");
  writeFileSync(join(repo, "feature.txt"), "feature line\n");
  git("add", "feature.txt");
  git("commit", "-qm", "feature work");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  const open = async () => {
    await page.goto(url + "plugins/bb-git-dashboard/git", { waitUntil: "load" });
    let entry = page.locator("button.git-table-entry", { hasText: "gamma" }).first();
    if (!await visible(entry, 8000)) {
      await page.getByRole("button", { name: "+ Подключить копию" }).click({ timeout: 30000 });
      const select = page.locator(".git-add-copy select").first();
      const value = await select.locator("option").evaluateAll(options => options.find(option => option.textContent.trim().endsWith("/gamma"))?.value ?? "");
      await select.selectOption(value);
      await page.getByRole("button", { name: "Подключить и показать worktree" }).click();
      entry = page.locator("button.git-table-entry", { hasText: "gamma" }).first();
    }
    await entry.click({ timeout: 30000 });
    await page.getByRole("navigation", { name: "Repository sections" }).getByRole("button", { name: "Review" }).click();
    return page.getByRole("region", { name: "Review" });
  };
  let review = await open();
  check("a clean branch opens on its commits since the base", await visible(review.getByRole("region", { name: "feature.txt" }))
    && await review.getByLabel("What to review").inputValue() === "branch");

  await review.getByLabel("What to review").selectOption("uncommitted");
  check("picking Uncommitted shows the empty view", await visible(review.getByText("No uncommitted changes.")));
  await review.getByLabel("Side by side").check();
  review = await open();
  check("the picked view and Side by side come back after a reload", await review.getByLabel("What to review").inputValue() === "uncommitted"
    && await review.getByLabel("Side by side").isChecked());

  writeFileSync(join(repo, "watched.txt"), "seen without reload\n");
  check("an edit on disk shows without Reload", await visible(review.getByRole("region", { name: "watched.txt" }), 15000));
  check("side by side shows the two sides", await review.locator(".git-review-split").count() > 0);

  mkdirSync(join(repo, "many"), { recursive: true });
  for (let index = 0; index < 30; index++) writeFileSync(join(repo, "many", "f" + String(index).padStart(2, "0") + ".txt"), "line " + index + "\n");
  writeFileSync(join(repo, "large.txt"), Array.from({ length: 2100 }, (_, index) => "row " + index).join("\n") + "\n");
  await review.getByRole("button", { name: "Reload" }).click();
  check("all 32 files are listed", await until(async () => await review.locator("section.git-review-file").count() === 32));
  check("every deferred patch is read in batches", await until(async () => await review.getByText("Reading this file's diff…").count() === 0
    && await review.getByRole("region", { name: "many/f29.txt" }).locator(".git-review-code", { hasText: "line 29" }).count() > 0));
  await review.getByRole("button", { name: "Find", exact: true }).click();
  await review.getByLabel("Find", { exact: true }).fill("line 2");
  check("Find counts the matches before stepping", await until(async () => await review.getByRole("search", { name: "Find in the diff" }).getByRole("status").innerText() === "11 matches"));
  const status = await review.getByRole("search", { name: "Find in the diff" }).getByRole("status").innerText();
  await review.getByLabel("Find", { exact: true }).press("Enter");
  check("Find steps to a match and marks it", await until(async () => await review.getByRole("search", { name: "Find in the diff" }).getByRole("status").innerText() === "1 of 11"
    && await review.locator(".git-review-row[data-current]").count() === 1), status);
  await review.getByLabel("Find", { exact: true }).press("Escape");
  await review.getByRole("button", { name: "Go to", exact: true }).click();
  await review.getByLabel("Go to file, comment or view").fill("f29");
  await review.getByLabel("Go to file, comment or view").press("Enter");
  check("Go to reaches a file", await until(async () => await page.evaluate(() => document.activeElement?.getAttribute("data-path")) === "many/f29.txt"));
  const large = review.getByRole("region", { name: "large.txt" });
  check("a large change starts folded and says so", await visible(large.getByText(/large change/)) && await large.locator(".git-review-row").count() === 0);
  await page.screenshot({ path: out + "/code-review-more.png", fullPage: false });

  const watched = review.getByRole("region", { name: "watched.txt" });
  await watched.getByLabel("Viewed").check();
  check("Viewed folds the file and survives a reload", await until(async () => await watched.locator(".git-review-row").count() === 0)
    && await (async () => { await review.getByRole("button", { name: "Reload" }).click(); await page.waitForTimeout(1500); return await watched.getByLabel("Viewed").isChecked(); })());
  writeFileSync(join(repo, "watched.txt"), "seen without reload\nand changed again\n");
  check("a Viewed file whose change moves on is unmarked", await until(async () => !(await watched.getByLabel("Viewed").isChecked())));
  writeFileSync(join(repo, ".diffityignore"), "large.txt\n");
  await review.getByRole("button", { name: "Reload" }).click();
  check("the copy's .diffityignore leaves files out and says how many", await visible(review.getByText(/· 1 ignored/))
    && await until(async () => await review.getByRole("region", { name: "large.txt" }).count() === 0));
  await watched.getByRole("button", { name: "Open", exact: true }).click();
  check("Open shows the file in BB's preview", await visible(page.getByText("and changed again").filter({ hasNot: page.locator(".git-review-code") })));

  await review.getByRole("region", { name: "watched.txt" }).getByRole("button", { name: "Comment on line 1" }).click();
  await review.getByLabel("Line comment").fill("Unsent for now");
  await review.getByRole("region", { name: "many/f03.txt" }).getByRole("button", { name: "▾" }).click();
  await page.waitForTimeout(1500);
  review = await open();
  const restored = [await visible(review.getByLabel("Line comment")), await review.getByLabel("Line comment").inputValue().catch(() => null),
    await review.getByRole("region", { name: "many/f03.txt" }).locator(".git-review-row").count()];
  check("an unsent line comment and a folded file survive a reload", restored[0] && restored[1] === "Unsent for now" && restored[2] === 0, restored);
  await review.getByLabel("Line comment").fill("To be **cleared**.");
  await review.getByRole("button", { name: "Comment", exact: true }).click();
  const thread = review.getByRole("article", { name: /Comment thread on watched\.txt:1/ });
  check("the comment is there, its Markdown rendered", await visible(thread) && await visible(thread.locator("strong", { hasText: "cleared" })));
  await review.getByRole("button", { name: "Next comment" }).click();
  check("Next comment focuses the comment", await until(async () => await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "") === "Comment thread on watched.txt:1 (new side)"));
  await review.getByRole("button", { name: "Clear review" }).click();
  await review.getByRole("alertdialog", { name: "Clear review" }).getByRole("button", { name: "Clear review" }).click();
  check("Clear review deletes the view's threads", await visible(review.getByText(/Cleared 1 comment thread/))
    && await until(async () => await review.getByRole("article", { name: /Comment thread on watched\.txt:1/ }).count() === 0));
  writeFileSync(join(repo, "README.md"), "a\nchanged by hand\n");
  const readme = review.getByRole("region", { name: "README.md" });
  check("the edit shows", await visible(readme.locator(".git-review-code", { hasText: "changed by hand" })));
  await readme.getByRole("button", { name: "Revert…" }).click();
  await review.getByRole("alertdialog", { name: "Revert README.md" }).getByRole("button", { name: "Revert", exact: true }).click();
  check("Revert puts the file back as committed", await until(async () => readFileSync(join(repo, "README.md"), "utf8") === "a\n")
    && await until(async () => await review.getByRole("region", { name: "README.md" }).count() === 0));

  await review.getByLabel("What to review").selectOption("files");
  await review.getByLabel("File to show").fill("READ");
  await review.getByRole("search", { name: "Find a file" }).getByRole("button", { name: "README.md" }).click();
  const whole = review.getByRole("region", { name: "README.md" });
  check("Any file shows a file as it is", await visible(whole.getByText(/file · 1 lines/)));
  await whole.getByRole("button", { name: "Comment on line 1" }).click();
  await review.getByLabel("Line comment").fill("About the whole README");
  await review.getByRole("button", { name: "Comment", exact: true }).click();
  review = await open();
  check("a file with a thread stays in Any file", await review.getByLabel("What to review").inputValue() === "files"
    && await visible(review.getByRole("article", { name: /Comment thread on README\.md:1/ })));

  await review.getByLabel("What to review").selectOption("commit");
  const commitList = review.getByLabel("Commit", { exact: true });
  await until(async () => await commitList.locator("option").count() > 1);
  const featureCommit = await commitList.locator("option").evaluateAll(options => options.find(option => option.textContent.includes("feature work"))?.value ?? "");
  await commitList.selectOption(featureCommit);
  check("a recent commit is picked from the list", await visible(review.getByRole("region", { name: "feature.txt" })) && /^[0-9a-f]{40}$/.test(featureCommit), featureCommit);
  await page.goto(url + "plugins/bb-git-dashboard/git", { waitUntil: "load" });
  check("the Reviews button counts open comment threads", await visible(page.getByRole("button", { name: /^Reviews/ }).getByLabel(/open comment threads/)));
  await page.getByRole("button", { name: /^Reviews/ }).click();
  const reviews = page.getByRole("region", { name: "Reviews" });
  check("the Reviews page lists the Any file review", await visible(reviews.getByRole("button", { name: /gamma.*files of the working copy/ })));
  await reviews.getByRole("button", { name: /gamma.*files of the working copy/ }).click();
  check("a review opens on its view", await until(async () => await page.getByLabel("What to review").inputValue().catch(() => "") === "files"));

  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 768 px", overflow <= 0, overflow);
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 400));
} finally { await browser.close(); }
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
