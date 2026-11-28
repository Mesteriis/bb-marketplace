// Browser probe of a copy's writes through its account (0.14.8), last in the run: the copy's head on a network origin
// asks the server for a preview and writes only after Confirm. stand-beta (linked to the Gitea stand-in's stand/beta)
// pushes a new branch — the first try has no credential in the helper and fails, and only a new preview tries again —
// fetches, and opens a pull request from the branch; each write reaches the stand-in exactly once. stand-alpha (an SSH
// origin no account serves) is told to link the copy, and nothing is written. Connections shows the activity.
// The bare stand/beta.git is made here, so the probes before it still see a forge without Git transport.
// Usage: node account-write.mjs <bbUrl> <toolsDir> <chrome> <outDir> (env STAND). Last line is PASS or FAIL.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url, tools, chrome, out] = process.argv.slice(2);
const stand = process.env.STAND;
const facts = Object.fromEntries(readFileSync(join(stand, "facts.env"), "utf8").trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
const bb = args => execFileSync("node", [join(facts.BB_APP, "dist/bb.js"), ...args], {encoding: "utf8", env: {HOME: join(stand, "home"), PATH: process.env.PATH,
  BB_SERVER_URL: url.replace(/\/$/, ""), BB_HOST_DAEMON_PORT: facts.DAEMON_PORT, BB_TELEMETRY: "false"}});
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
const until = async (test, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return true; await new Promise(done => setTimeout(done, 250)); } return false; };

const beta = join(stand, "home/projects/beta");
const bare = join(stand, "forge/git/stand/beta.git");
const writes = join(stand, "forge/writes.log");
const credentials = join(stand, "forge/credentials.log");
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.email=stand@example.invalid", "-c", "user.name=stand", ...args], {encoding: "utf8"}).trim();
const logged = () => existsSync(writes) ? readFileSync(writes, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const pushes = () => logged().filter(entry => entry.git === "git-receive-pack").length;
const fetches = () => logged().filter(entry => entry.git === "fetch-refs").length;
const pullsMade = () => logged().filter(entry => entry.method === "POST" && entry.path === "/api/v1/repos/stand/beta/pulls");
const machineIds = () => {
  const ids = [];
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") { if (typeof value.id === "string") ids.push(value.id); Object.values(value).forEach(walk); }
  };
  walk(JSON.parse(bb(["machine", "list", "--json"])));
  return [...new Set(ids)];
};

let startBranch = "main";
try {
  // stand/beta on the Gitea stand-in: a bare repository with beta's main, served over Git from now on; a branch to push.
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
  startBranch = git(beta, "rev-parse", "--abbrev-ref", "HEAD");
  execFileSync("git", ["-C", beta, "push", "-q", bare, "main:refs/heads/main"]);
  git(beta, "switch", "-q", "-c", "account-push");
  writeFileSync(join(beta, "account-write.txt"), "pushed through the account\n");
  git(beta, "add", "--", "account-write.txt");
  git(beta, "commit", "-q", "-m", "A branch pushed through the account", "--", "account-write.txt");
  const head = git(beta, "rev-parse", "HEAD");
  const machines = machineIds();
  check("BB lists the stand's machines", machines.length > 0, machines);

  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await context.addInitScript(value => localStorage.setItem("bb.theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    const open = async name => {
      await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
      await page.locator(".git-projects-table").getByText(name, { exact: true }).first().click({ timeout: 30000 });
      await page.locator(".git-project-head").waitFor({ timeout: 30000 });
      await page.locator(".git-project-head .g-branch").first().waitFor({ timeout: 30000 });
    };
    const head$ = page.locator(".git-project-head");
    const button = name => head$.getByRole("button", { name, exact: true });

    if (theme === "dark") {
      // The preview in the dark theme, then Cancel: nothing is written.
      await open("beta");
      const before = pushes();
      await head$.getByRole("button", { name: /^Push/ }).click();
      const dialog = page.getByRole("dialog", { name: "Push through the account" });
      check("dark: Push opens the account's preview", await visible(dialog, 30000));
      await page.waitForTimeout(400);
      await page.screenshot({ path: out + "/account-push-preview-dark.png" });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.waitForTimeout(1000);
      check("dark: Cancel writes nothing", pushes() === before, pushes());
      check("dark: no page errors", errors.length === 0, errors);
      await context.close();
      continue;
    }

    // A copy whose origin no linked account serves: told to link it; no preview, no write, no Create pull request.
    await open("alpha");
    const quiet = logged().length;
    check("a copy not linked offers no Create pull request", await button("Fetch").isVisible() && await button("Create pull request").count() === 0);
    await button("Fetch").click();
    const told = head$.getByRole("alert");
    check("Fetch on a copy not linked says to link it on the CI/CD tab", await visible(told, 30000) && /not linked to an account repository/.test(await told.innerText()),
      await told.innerText().catch(() => ""));
    check("... and opens no preview and writes nothing", await page.getByRole("dialog").count() === 0 && logged().length === quiet);

    // Push through the account: the preview says what goes where; Confirm without the helper's credential fails once.
    await open("beta");
    check("a linked copy offers Create pull request", await visible(button("Create pull request")));
    await head$.getByRole("button", { name: /^Push/ }).click();
    let dialog = page.getByRole("dialog", { name: "Push through the account" });
    check("Push on a network origin opens the account's preview", await visible(dialog, 30000));
    const lines = (await dialog.locator(".git-account-lines li").allInnerTexts()).join("\n");
    check("the preview names the account, the repository, the copy's branch and the commit", /gitea · https:\/\/localhost:\d+ · stand \(stand\)/.test(lines)
      && lines.includes("stand/beta") && lines.includes("account-push") && lines.includes(head + " → refs/heads/account-push"), lines);
    check("the preview names the machine, not its id", machines.every(id => !lines.includes(id)), lines);
    await page.screenshot({ path: out + "/account-push-preview-light.png" });
    await dialog.getByRole("button", { name: "Confirm" }).click();
    const refused = dialog.getByRole("alert");
    check("without the credential the push fails and says so", await visible(refused, 60000) && /GIT_REJECTED/.test(await refused.innerText()), await refused.innerText().catch(() => ""));
    check("after a failure only Close is left: a new try needs a new preview", /start the action anew/.test(await refused.innerText())
      && await dialog.getByRole("button", { name: "Confirm" }).count() === 0 && await visible(dialog.getByRole("button", { name: "Close" })));
    check("the failed push wrote nothing", pushes() === 0 && git(bare, "for-each-ref", "refs/heads/account-push") === "", pushes());
    await page.screenshot({ path: out + "/account-push-failed-light.png" });
    await dialog.getByRole("button", { name: "Close" }).click();

    // The helper gets the account's credential for this repository; a new preview, one Confirm, one push.
    const host = new URL(facts.FORGE).host;
    appendFileSync(credentials, JSON.stringify({action: "store", key: ["https", host, "stand/beta.git", "stand"].join("|"),
      fields: {protocol: "https", host, path: "stand/beta.git", username: "stand", password: "stand-token"}}) + "\n");
    await head$.getByRole("button", { name: /^Push/ }).click();
    dialog = page.getByRole("dialog", { name: "Push through the account" });
    check("Push again asks for a new preview", await visible(dialog.getByRole("button", { name: "Confirm" }), 30000));
    await dialog.getByRole("button", { name: "Confirm" }).click();
    check("Confirm pushes through the account and says so", await visible(head$.getByRole("status").filter({ hasText: "Pushed through the account." }), 60000));
    check("exactly one push reached the forge, with the commit", pushes() === 1 && git(bare, "rev-parse", "refs/heads/account-push") === head, pushes());

    // Fetch through the account: origin/main is dropped first, the fetch brings it back.
    execFileSync("git", ["-C", beta, "update-ref", "-d", "refs/remotes/origin/main"]);
    const fetchedBefore = fetches();
    await button("Fetch").click();
    dialog = page.getByRole("dialog", { name: "Fetch through the account" });
    check("Fetch on a network origin opens the account's preview", await visible(dialog, 30000));
    await dialog.getByRole("button", { name: "Confirm" }).click();
    check("Confirm fetches through the account and says so", await visible(head$.getByRole("status").filter({ hasText: "Fetched through the account." }), 60000));
    check("the fetch brought origin's branches, and pushed nothing", git(beta, "rev-parse", "refs/remotes/origin/account-push") === head && pushes() === 1 && fetches() === fetchedBefore + 1,
      {fetches: fetches(), pushes: pushes()});

    // Create pull request: base, title, description, then the preview, then exactly one request to the forge.
    const madeBefore = pullsMade().length;
    await button("Create pull request").click();
    const form = page.getByRole("dialog", { name: "Create pull request" });
    check("Create pull request asks for base, title and description", await visible(form.getByLabel("Base branch"), 30000)
      && await form.getByLabel("Base branch").inputValue() === "main");
    await form.getByLabel("Title").fill("Stand account pull request");
    await form.getByLabel("Description").fill("Made by the account-write probe.");
    await form.getByRole("button", { name: "Review" }).click();
    dialog = page.getByRole("dialog", { name: "Create pull request" }).filter({ has: page.locator(".git-account-lines") });
    check("the pull request's preview names head, base and title", await visible(dialog, 30000)
      && /stand\/beta:account-push @ [0-9a-f]{40}/.test(await dialog.innerText()) && (await dialog.innerText()).includes("Stand account pull request"));
    check("the preview alone sends nothing", pullsMade().length === madeBefore);
    await page.screenshot({ path: out + "/account-pr-preview-light.png" });
    await dialog.getByRole("button", { name: "Confirm" }).click();
    check("Confirm creates the pull request and says its number", await visible(head$.getByRole("status").filter({ hasText: "Pull request #9 created." }), 60000));
    const made = pullsMade().slice(madeBefore);
    check("exactly one pull request was asked of the forge, from the pushed branch into main", made.length === 1 && made[0].body?.head === "account-push"
      && made[0].body?.base === "main" && made[0].body?.title === "Stand account pull request", made);

    // Connections: the activity of the writes through the accounts.
    await page.goto(url + "plugins/bb-git-dashboard/git/connections", { waitUntil: "load" });
    const activity = page.getByRole("region", { name: "Publication activity" }).or(page.locator("section[aria-labelledby='git-connection-activity']"));
    await activity.getByRole("button", { name: "Show" }).click({ timeout: 30000 });
    const rows = activity.locator("tbody tr");
    await until(async () => await rows.count() >= 4);
    const text = await rows.allInnerTexts();
    check("Connections lists the push (failed, then done), the fetch and the pull request", text.some(row => /Push/.test(row) && /failed/.test(row))
      && text.some(row => /Push/.test(row) && /done/.test(row)) && text.some(row => /Fetch/.test(row) && /done/.test(row)) && text.some(row => /Pull request #9/.test(row)), text);
    await page.screenshot({ path: out + "/connections-activity-light.png" });
    check("light: no page errors", errors.length === 0, errors);
    await context.close();
  }
} catch (error) {
  check("probe ran to the end", false, String(error).slice(0, 800));
} finally {
  await browser.close();
  try { git(beta, "switch", "-q", startBranch); git(beta, "branch", "-q", "-D", "account-push"); } catch { /* The stand is thrown away after the run. */ }
}
console.log(failures.length ? "FAIL" : "PASS");
process.exit(failures.length ? 1 : 0);
