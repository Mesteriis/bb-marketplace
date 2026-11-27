// Browser probe of 0.10 on stand-alpha: a merge previewed with its conflict, stopped, resolved in the conflict editor
// and continued into a merge commit; a rebase whose conflict is answered with picked lines and a hand edit, keeping the
// commit's author; a merge aborted back to where it was. Every write goes through a confirmation. Run it after the
// probes that read alpha as run.sh leaves it (smoke, history). Last line is PASS or FAIL.
// Usage: node merge.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, tools, chrome, out] = process.argv.slice(2);
const repo = join(process.env.STAND, "home/projects/alpha");
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.email=stand@example.invalid", "-c", "user.name=stand", ...args], { encoding: "utf8" });
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const until = async (condition, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 300)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
try {
  // A clean main, a topic branch and main both changing the second line of merge.txt, and a third branch for the abort.
  git("add", "-A"); git("commit", "-qm", "stand: leftover changes");
  writeFileSync(join(repo, "merge.txt"), "one\ntwo\nthree\n"); git("add", "merge.txt"); git("commit", "-qm", "merge base");
  git("switch", "-q", "-c", "topic"); writeFileSync(join(repo, "merge.txt"), "one\ntopic\nthree\n"); git("commit", "-qam", "topic work");
  git("switch", "-q", "-c", "stray", "main"); writeFileSync(join(repo, "merge.txt"), "one\nstray\nthree\n"); git("commit", "-qam", "stray work");
  git("switch", "-q", "main"); writeFileSync(join(repo, "merge.txt"), "one\nmain\nthree\n"); git("commit", "-qam", "main work");
  const before = git("rev-parse", "HEAD").trim();

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  const dialog = page.getByRole("dialog");
  // alpha has no Git author of its own: a write that makes commits asks for one in its confirmation.
  let asked = 0;
  const confirm = async () => {
    // The dialog opens once the preview is read: wait for it before looking for the author fields.
    await dialog.getByRole("button", { name: "Confirm" }).waitFor({ timeout: 20000 });
    if (await dialog.getByLabel("Git author name").count()) {
      asked++;
      await dialog.getByLabel("Git author name").fill("Stand Owner");
      await dialog.getByLabel("Git author email").fill("owner@example.invalid");
    }
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await dialog.waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
  };
  const open = async () => {
    await page.goto(url + "plugins/bb-git-dashboard/git", { waitUntil: "load" });
    let entry = page.locator("button.git-table-entry", { hasText: "alpha" }).first();
    if (!await visible(entry, 8000)) {
      await page.getByRole("button", { name: "+ Подключить копию" }).click({ timeout: 30000 });
      const select = page.locator(".git-add-copy select").first();
      const value = await select.locator("option").evaluateAll(options => options.find(option => option.textContent.trim().endsWith("/alpha"))?.value ?? "");
      await select.selectOption(value);
      await page.getByRole("button", { name: "Подключить и показать worktree" }).click();
      entry = page.locator("button.git-table-entry", { hasText: "alpha" }).first();
    }
    await entry.click({ timeout: 30000 });
    await page.getByRole("navigation", { name: "Worktree views" }).getByRole("button", { name: "Branches" }).click({ timeout: 30000 });
  };
  const branch = name => page.getByRole("list", { name: "Branches" }).getByRole("listitem").filter({ has: page.locator(".git-path", { hasText: new RegExp("^" + name + "$") }) });

  await open();
  await branch("topic").getByRole("button", { name: "Merge into main" }).click();
  check("the merge is previewed with what it brings and the file it will conflict in", await visible(dialog.getByText("Merge topic (1 commit) into main"))
    && await visible(dialog.getByText(/Expected conflicts in 1 file: merge\.txt\./)));
  check("nothing happened before Confirm", git("rev-parse", "HEAD").trim() === before && git("status", "--porcelain") === "");
  await confirm();
  const bar = page.getByRole("region", { name: "Merge in progress" });
  check("the merge stops on its conflict", await visible(bar.getByText("1 conflicted file")) && /MERGE_HEAD/.test(execFileSync("ls", [join(repo, ".git")], { encoding: "utf8" })));
  const editor = page.getByRole("region", { name: "Resolve merge.txt" });
  check("the conflict editor opens on the file, with both sides and the base", await visible(editor.getByRole("article", { name: "Conflict 1 of 1" }))
    && await visible(editor.getByText("Base (before both)")) && await visible(editor.locator(".git-merge-side[data-side='theirs'] code", { hasText: "topic" })));
  await editor.getByRole("button", { name: "Incoming", exact: true }).click();
  check("the answer builds the result", await editor.getByLabel("Resolved text").inputValue() === "one\ntopic\nthree\n");
  await page.screenshot({ path: out + "/merge-editor.png", fullPage: false });
  await editor.getByRole("button", { name: "Save and mark resolved" }).click();
  check("saving is confirmed first", await visible(dialog.getByText("Write the result over merge.txt and mark the conflict resolved.")));
  await confirm();
  check("the file is resolved and staged", await visible(bar.getByText("No conflicts left")) && readFileSync(join(repo, "merge.txt"), "utf8") === "one\ntopic\nthree\n");
  await bar.getByRole("button", { name: "Continue" }).click();
  check("Continue says it commits the merge", await visible(dialog.getByText("Commit the merge with the resolved files.")));
  await confirm();
  check("a merge commit with both parents ends it", await until(async () => await bar.count() === 0)
    && git("log", "-1", "--format=%P").trim().split(" ").length === 2 && git("log", "-1", "--format=%s").trim() === "Merge branch 'topic'"
    && git("log", "-1", "--format=%an").trim() === "Stand Owner");
  check("the author is asked where the copy has none", asked >= 2, asked);

  // A rebase of a branch onto main, its conflict answered with picked lines and then edited by hand.
  git("switch", "-q", "-c", "rebase-me", "topic~1");
  writeFileSync(join(repo, "merge.txt"), "one\nmine\nthree\n");
  git("-c", "user.name=Author", "-c", "user.email=author@example.invalid", "commit", "-qam", "rebase work");
  await open();
  await branch("main").getByRole("button", { name: "Rebase onto" }).click();
  check("the rebase is previewed", await visible(dialog.getByText(/^Rebase rebase-me \(1 commit\) onto main \(\d+ new commits\)$/))
    && await visible(dialog.getByText(/Likely conflicts in 1 file: merge\.txt\. The rebase stops/)), await dialog.innerText().catch(() => ""));
  await confirm();
  const rebase = page.getByRole("region", { name: "Rebase in progress" });
  check("the rebase stops at the commit, one of one", await visible(rebase.getByText("Rebase in progress · commit 1 of 1")));
  const rebaseEditor = page.getByRole("region", { name: "Resolve merge.txt" });
  await rebaseEditor.getByLabel("Take line 1 of Your commit").check();
  await rebaseEditor.getByLabel("Take line 1 of Upstream (rebasing onto)").check();
  check("picked lines make the result, ours first", await rebaseEditor.getByLabel("Resolved text").inputValue() === "one\ntopic\nmine\nthree\n");
  await rebaseEditor.getByLabel("Resolved text").fill("one\ntopic and mine\nthree\n");
  await rebaseEditor.getByRole("button", { name: "Save and mark resolved" }).click();
  await confirm();
  await rebase.getByRole("button", { name: "Continue" }).click();
  await confirm();
  check("the rebased commit sits on main and keeps its author", await until(async () => await rebase.count() === 0)
    && git("log", "-1", "--format=%P").trim() === git("rev-parse", "main").trim()
    && git("log", "-1", "--format=%an|%cn").trim() === "Author|Stand Owner", git("log", "-1", "--format=%an|%cn|%P").trim());
  check("with the hand-edited text", readFileSync(join(repo, "merge.txt"), "utf8") === "one\ntopic and mine\nthree\n");

  // A merge stopped on its conflict and aborted back to where it was.
  git("switch", "-q", "main");
  const head = git("rev-parse", "HEAD").trim();
  await open();
  await branch("stray").getByRole("button", { name: "Merge into main" }).click();
  check("the second merge is previewed with its conflict", await visible(dialog.getByText(/Expected conflicts in 1 file: merge\.txt\./)), await dialog.innerText().catch(() => ""));
  await confirm();
  const stray = page.getByRole("region", { name: "Merge in progress" });
  await stray.getByRole("button", { name: "Abort" }).click();
  check("Abort warns that resolutions are lost", await visible(dialog.getByText("Resolutions made so far are lost.")));
  await confirm();
  check("Abort puts the branch back", await until(async () => await stray.count() === 0) && git("rev-parse", "HEAD").trim() === head && git("status", "--porcelain") === "");

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
