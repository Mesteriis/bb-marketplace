// Acceptance on the isolated BB stand (development runtime), one line per check
// of the plan's "Проверка" section that this stand can exercise.
// Usage: node acceptance.mjs <bbUrl> <toolsDir> <chrome> <outDir> <project> <thread> <repo> <standDir>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, toolsDir, chrome, out, project, thread, repo, stand] = process.argv.slice(2);
const { chromium } = createRequire(toolsDir + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const invokes = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("request", (r) => {
  if (r.url().includes("/gw/invoke")) invokes.push(JSON.parse(r.postData() ?? "{}").cmd);
});
const results = [];
const check = (id, name, ok, detail) => {
  const r = { id, name, result: ok === null ? "не проверялось" : ok ? "прошло" : "не прошло", detail };
  results.push(r);
  console.log(`${r.id}\t${r.result}\t${r.name}\t${JSON.stringify(r.detail ?? "").slice(0, 300)}`);
};
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
const sleep = (ms) => page.waitForTimeout(ms);
const until = async (fn, ms = 10000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await fn()) return true;
    await sleep(250);
  }
  return !!(await fn());
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    errors.push(`${name}: ${String(e.message ?? e).split("\n")[0].slice(0, 160)}`);
  }
};

// Setup on disk: a bare remote, not yet pushed.
const bare = `${stand}/remote.git`;
execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
git("remote", "add", "origin", bare);

const frame = page.frameLocator('iframe[title="GitWand"]');
const fr = () => page.frames().find((f) => f.url().includes("/http/ui/index.html"));
const iframe = page.locator('iframe[title="GitWand"]');
async function panelWidth(target) {
  const box = await iframe.boundingBox();
  const left = box.x - 1;
  await page.mouse.move(left, 400);
  await page.mouse.down();
  await page.mouse.move(left + (box.width - target), 400, { steps: 10 });
  await page.mouse.up();
  await sleep(700);
  return Math.round((await iframe.boundingBox()).width);
}
/** Whether the element's centre point hits the element itself (not covered). */
const visibleAtCentre = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.width > 0 && (hit === el || el.contains(hit));
  });

// 1. Thread action opens the tab on the thread's repository.
await page.goto(`${url}projects/${project}/threads/${thread}`, { waitUntil: "load" });
await sleep(2500);
await page.getByRole("button", { name: "GitWand", exact: true }).last().click();
await iframe.waitFor({ timeout: 20000 }).catch(() => {});
await frame.getByText("modified").first().waitFor({ timeout: 30000 }).catch(() => {});
const src = await iframe.getAttribute("src").catch(() => null);
check(1, "Действие треда открывает вкладку, репозиторий треда открыт сразу", (src ?? "").endsWith(`?repo=${encodeURIComponent(repo)}`) && (await fr()?.evaluate(() => !!window.__TAURI_INTERNALS__)) === true, src);
await page.screenshot({ path: `${out}/01-tab-1280.png` });

// 11. Narrow tab: 480 and 560 px, Stage all and Commit not covered by the dock.
await step("commit view", () => frame.getByRole("button", { name: "Commit", exact: true }).first().click());
await frame.getByText("changed.txt").first().waitFor({ timeout: 15000 }).catch(() => {});
const narrow = {};
for (const w of [480, 560]) {
  const got = await panelWidth(w);
  const stageAll = frame.getByRole("button", { name: /^Stage all/ }).first();
  const commitBtn = frame.getByRole("button", { name: /^Commit \(\d+\)/ }).first();
  narrow[w] = { width: got, stageAll: await visibleAtCentre(stageAll).catch(() => false), commit: await visibleAtCentre(commitBtn).catch(() => false) };
  await page.screenshot({ path: `${out}/11-narrow-${w}.png` });
}
check(11, "Узкая вкладка 480 и 560 px: Stage all и Commit видимы и не перекрыты", Object.values(narrow).every((n) => n.stageAll && n.commit && Math.abs(n.width - Object.keys(narrow).find((k) => narrow[k] === n)) <= 30), narrow);

// 2. Status → stage → commit with GitWand's own buttons, at 560 px.
const summary = `acceptance commit ${Date.now()}`;
await step("stage all", () => frame.getByRole("button", { name: /^Stage all/ }).first().click());
await until(() => git("diff", "--cached", "--name-only") === "changed.txt", 8000);
await step("summary", () => frame.getByPlaceholder("Summary (required)").fill(summary));
await step("commit", () => frame.getByRole("button", { name: /^Commit \(\d+\)/ }).first().click());
await until(() => git("log", "-1", "--format=%s") === summary, 10000);
check(2, "Статус → stage → commit кнопками GitWand; git log -1 на диске", git("log", "-1", "--format=%s") === summary && git("status", "--porcelain") === "", git("log", "-1", "--format=%s"));
await panelWidth(900);

// 4. An external change shows up by itself (watcher channel): GitWand counts it.
writeFileSync(`${repo}/watched.txt`, "hello-watcher\n");
const watched = await until(async () => (await frame.getByText("1 untracked").count()) > 0, 15000);
check(4, "Внешнее изменение файла появляется само (канал watcher)", watched, { watchCalls: invokes.filter((c) => c === "watch_repo_start").length });

// 3b. History/graph: both commits listed.
const history = await until(async () => (await frame.getByText(summary).count()) > 0 && (await frame.getByText("first commit").count()) > 0, 8000);

// 3a. Diff of a file: open the work in progress, then the file.
await step("open WIP", () => frame.getByText("// WIP").first().click());
await sleep(1000);
await step("open file", () => frame.getByText("watched.txt").first().click());
const diffShown = await until(async () => (await frame.getByText("hello-watcher").count()) > 0, 10000);
await page.screenshot({ path: `${out}/03-diff.png` });


// 3c. Branch: create in the dialog, switch to it, switch back.
await step("new branch", () => frame.getByRole("button", { name: "New branch", exact: true }).click());
await step("branch name", () => frame.getByPlaceholder("Branch name…").fill("feature-stand"));
await step("create", () => frame.getByRole("button", { name: "Create", exact: true }).click());
await sleep(800);
// GitWand asks what to do with the uncommitted file: take it to the new branch.
const bring = frame.getByRole("button", { name: "Bring changes along", exact: true });
if (await bring.isVisible().catch(() => false)) await step("bring changes", () => bring.click());
const created = await until(() => git("branch", "--list", "feature-stand") !== "", 10000);
const switchTo = async (name) => {
  await step(`menu for ${name}`, () => frame.locator("button", { hasText: /^\s*(main|feature-stand)\b/ }).first().click());
  await sleep(800);
  await step(`pick ${name}`, () => frame.locator("li.bp-item").filter({ has: frame.locator(".bp-item-name__text", { hasText: new RegExp(`^${name}$`) }) }).first().click());
  await sleep(800);
  const along = frame.getByRole("button", { name: "Bring changes along", exact: true });
  if (await along.isVisible().catch(() => false)) await step("bring changes on switch", () => along.click());
  return until(() => git("branch", "--show-current") === name, 10000);
};
const onFeature = git("branch", "--show-current") === "feature-stand" || (await switchTo("feature-stand"));
await page.screenshot({ path: `${out}/03-branch.png` });
const backOnMain = await switchTo("main");
check(3, "Diff, история/граф, ветка (создать, переключить)", diffShown && history && created && onFeature && backOnMain, { diffShown, history, created, onFeature, backOnMain, current: git("branch", "--show-current") });
await page.keyboard.press("Escape");

// 5. Push to the local bare repository, fetch and pull its new commit.
const report5 = {};
await step("stage watched", async () => {
  git("add", "watched.txt");
  git("-c", "user.email=a@example.invalid", "-c", "user.name=a", "commit", "-qm", "watched file");
});
await step("publish", () => frame.getByRole("button", { name: /^(Publish branch|Push)/ }).first().click());
const pushed = await until(() => {
  try {
    return execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === git("rev-parse", "HEAD");
  } catch {
    return false;
  }
}, 20000);
await page.screenshot({ path: `${out}/05-push.png` });
if (!pushed) git("push", "-q", "origin", "main"); // so fetch and pull can still be checked
const other = `${stand}/other`;
let remoteHead = "";
await step("remote commit", async () => {
  execFileSync("git", ["clone", "-q", bare, other]);
  writeFileSync(`${other}/remote.txt`, "from the remote\n");
  execFileSync("git", ["-C", other, "add", "."]);
  execFileSync("git", ["-C", other, "-c", "user.email=b@example.invalid", "-c", "user.name=b", "commit", "-qm", "remote commit"]);
  execFileSync("git", ["-C", other, "push", "-q", "origin", "main"]);
  remoteHead = execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
});
// After the push GitWand's Fetch button becomes its sync button ("Up to date", then "Pull").
const sync = () => frame.getByRole("button", { name: /^(Fetch|Up to date|Pull)/ }).first();
await step("fetch", async () => {
  report5.fetchButton = (await sync().textContent())?.trim();
  await sync().click();
});
const fetched = await until(() => {
  try {
    return git("rev-parse", "origin/main") === remoteHead;
  } catch {
    return false;
  }
}, 20000);
await step("pull", async () => {
  await until(async () => /^Pull/.test(((await sync().textContent()) ?? "").trim()), 8000);
  report5.pullButton = (await sync().textContent())?.trim();
  await sync().click();
});
const pulled = await until(() => git("rev-parse", "HEAD") === remoteHead, 20000);
await page.screenshot({ path: `${out}/05-sync.png` });
check(5, "Fetch/pull/push на локальном bare-репозитории", pushed && fetched && pulled, { pushed, fetched, pulled, ...report5, fetchCalls: invokes.filter((c) => c === "git_fetch").length });

// 6. Terminal: git --version, resize.
const proof = `${repo}/git-version.txt`;
const tp = frame.locator(".tp").first();
if (!(await tp.isVisible().catch(() => false))) await step("terminal button", () => frame.getByRole("button", { name: "Terminal", exact: true }).click());
await tp.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
await sleep(1200);
const before = invokes.filter((c) => c === "terminal_resize").length;
await step("focus terminal", async () => {
  const b = await tp.boundingBox();
  await tp.click({ position: { x: Math.round(b.width / 2), y: Math.round(b.height * 0.65) } });
});
await page.keyboard.type("git --version > git-version.txt\n");
await until(() => existsSync(proof) && readFileSync(proof, "utf8").trim() !== "", 10000);
await panelWidth(700);
await sleep(1500);
const resized = invokes.filter((c) => c === "terminal_resize").length > before;
const version = existsSync(proof) ? readFileSync(proof, "utf8").trim() : "no file";
check(6, "Терминал GitWand: git --version выводит версию, ресайз работает", /^git version \d/.test(version) && resized, { version, resized });
await page.screenshot({ path: `${out}/06-terminal.png` });

// 3d. Merge with a conflict, resolved in GitWand.
await step("conflict setup", async () => {
  git("checkout", "-q", "-b", "conflict-side");
  writeFileSync(`${repo}/changed.txt`, "side\n");
  git("-c", "user.email=a@example.invalid", "-c", "user.name=a", "commit", "-qam", "side change");
  git("checkout", "-q", "main");
  writeFileSync(`${repo}/changed.txt`, "main\n");
  git("-c", "user.email=a@example.invalid", "-c", "user.name=a", "commit", "-qam", "main change");
  try {
    git("merge", "conflict-side");
  } catch {}
});
const conflicted = git("diff", "--name-only", "--diff-filter=U") === "changed.txt";
const conflictShown = await until(async () => (await frame.getByText("Merge paused").count()) > 0, 15000);
await page.screenshot({ path: `${out}/03-conflict.png` });
// Resolve in GitWand's conflict editor: take the incoming side, then continue the merge.
await step("open WIP for the conflict", () => frame.getByText("// WIP").first().click());
await sleep(800);
await step("open conflicted file", () => frame.getByText("changed.txt").first().click());
await step("take incoming", () => frame.getByRole("button", { name: "Incoming", exact: true }).first().click());
await sleep(1200);
await page.screenshot({ path: `${out}/03-conflict-resolved.png` });
await step("continue merge", () => frame.getByRole("button", { name: "Continue", exact: true }).first().click());
const merged = await until(() => git("log", "-1", "--format=%P").split(" ").length === 2, 15000);
const content = readFileSync(`${repo}/changed.txt`, "utf8");
check("3-merge", "Merge с конфликтом через редактор GitWand", conflicted && conflictShown && merged && content === "side\n", { conflictedOnDisk: conflicted, conflictShownInUi: conflictShown, mergeCommit: merged, changedTxt: content.trim() });
check("3-auto", "Авторазрешение конфликта", null, "нет набора конфликтов, которые GitWand разрешает сам; проверялся только ручной путь");
if (!merged) {
  try {
    git("merge", "--abort");
  } catch {}
}

// 7, 8. Keychain sign-in and forges need test accounts the stand does not have.
check(7, "Keychain: вход в Bitbucket и Gitea, сохраняется после перезапуска bridge", null, "нет тестовых аккаунтов стенда");
check(8, "Форджи: GitHub без gh, Bitbucket, Azure, Gitea, GitLab с glab", null, "нет тестовых аккаунтов стенда");

check("errors", "Ошибки страницы", errors.length === 0, errors);
writeFileSync(`${out}/acceptance.json`, JSON.stringify(results, null, 1));
await browser.close();
