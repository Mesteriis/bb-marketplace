// Browser probe of the 0.9.3 pull request parity on the Gitea stand-in: My PRs' tiles, Updated N ago, Collapse and
// Expand all, and coming back on the same search and row; on #3 its Jira keys as links and Markdown, deleting your own
// comment through the confirmation, the Files list, Shiki highlighting (one grammar fetched, for TypeScript only),
// Side by side kept over a reload, j / k and n, a thread's diff fragment and Show in diff; a github.com pull request
// link clicked outside Makosh Git opening inside it; the Notifications settings' test notification.
// Usage: node pr-parity.mjs <bbUrl> <toolsDir> <chrome> <outDir>   (env STAND). Last line is PASS or FAIL.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [url, tools, chrome, out] = process.argv.slice(2);
const writes = () => readFileSync(process.env.STAND + "/forge/writes.log", "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); if (!ok) failures.push(name); };
const until = async (condition, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 250)); } return false; };
const visible = async (locator, timeout = 20000) => { await locator.first().waitFor({ timeout }).catch(() => {}); return await locator.count() > 0; };
const active = page => page.evaluate(() => ({path: document.activeElement?.getAttribute("data-path") ?? null, thread: document.activeElement?.getAttribute("data-thread-id") ?? null,
  row: document.activeElement?.getAttribute("data-pr-row") ?? null}));
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
  const grammars = [];
  page.on("request", request => { const found = /\/http\/grammar\?id=([\w-]+)/.exec(request.url()); if (found) grammars.push(found[1]); });
  // The accounts the link overlay reads gain a github.com account, in the browser only: no request leaves the machine.
  let accountsSeen = false;
  await page.route(target => target.pathname.includes("bb-git-dashboard"), async route => {
    const request = route.request();
    const asks = /accounts/.test(request.url()) || /"accounts"/.test(request.postData() ?? "");
    if (!asks) return route.continue();
    const response = await route.fetch();
    let body;
    try { body = await response.json(); } catch { return route.fulfill({ response }); }
    const add = value => {
      if (Array.isArray(value)) {
        if (value.length && value.every(item => item && typeof item === "object" && "kind" in item && "origin" in item && "username" in item)) {
          value.push({ kind: "github", id: "stand-github", label: "github", origin: "https://github.com", organization: "", username: "stand" });
          accountsSeen = true;
          return;
        }
        value.forEach(add);
      } else if (value && typeof value === "object") Object.values(value).forEach(add);
    };
    add(body);
    return route.fulfill({ response, json: body });
  });

  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: /^My PRs\b/ }).click({ timeout: 30000 });
  const inbox = page.getByRole("region", { name: "My pull requests" });
  const row = inbox.locator(".git-inbox-item", { hasText: "Add greeting check" });
  check("My PRs lists the open pull request", await visible(row));
  check("it says when the list was read", await visible(inbox.getByText(/^Updated (just now|\d+ min ago)$/)));
  const tiles = inbox.getByRole("list", { name: "Open pull requests at a glance" });
  const tile = label => tiles.getByRole("listitem").filter({ hasText: label }).locator("strong").innerText().catch(() => "");
  check("the Open tiles count CI failing and nothing ready", await tile("CI failing") === "1" && await tile("Ready to merge") === "0",
    [await tile("CI failing"), await tile("Unresolved comments"), await tile("Changes requested"), await tile("Ready to merge")]);
  await inbox.getByRole("button", { name: "Collapse all" }).click();
  check("Collapse all folds every repository", await until(async () => await inbox.locator(".git-inbox-item").count() === 0));
  await inbox.getByRole("button", { name: "Expand all" }).click();
  check("Expand all unfolds them", await visible(row));
  await inbox.getByLabel("Search pull requests").fill("greeting");
  await row.locator("a").first().click();

  const pr = page.getByRole("region", { name: "Pull request stand/beta #3" });
  check("the pull request opens", await visible(pr.getByRole("heading", { name: /Add greeting check/ })));
  const titleKey = pr.getByRole("heading").getByRole("link", { name: "ABC-12" });
  check("a Jira key in the title opens on the Jira site the description links to",
    await visible(titleKey) && await titleKey.getAttribute("href") === "https://acme.atlassian.net/browse/ABC-12", await titleKey.getAttribute("href").catch(() => null));
  const description = pr.locator(".git-review-markdown").first();
  check("the description is Markdown with its Jira key linked", await visible(description.locator("strong", { hasText: "carefully" }))
    && await description.getByRole("link", { name: "ABC-12" }).getAttribute("href") === "https://acme.atlassian.net/browse/ABC-12");
  check("only your own comment offers Delete", await visible(pr.getByRole("button", { name: "Delete stand's comment" }))
    && await pr.getByRole("button", { name: "Delete alice's comment" }).count() === 0);
  await pr.getByRole("button", { name: "Delete stand's comment" }).click();
  const dialog = page.getByRole("dialog");
  check("deleting is previewed with the comment", await visible(dialog.getByText("Delete your comment on stand/beta #3")) && await visible(dialog.getByText("My own note.")));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await dialog.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  check("and reaches Gitea as one DELETE of that comment", await until(async () => writes().filter(write => write.method === "DELETE" && write.path === "/api/v1/repos/stand/beta/issues/comments/32").length === 1),
    writes().filter(write => write.method === "DELETE"));

  await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: /^My\ PRs\b/ }).click();
  check("back on My PRs the search is kept", await until(async () => await inbox.getByLabel("Search pull requests").inputValue().catch(() => "") === "greeting"));
  check("and the opened row has the focus", await until(async () => (await active(page)).row !== null), await active(page));
  await row.locator("a").first().click();
  await visible(pr.getByRole("heading", { name: /Add greeting check/ }));

  const sections = pr.getByRole("navigation", { name: "Pull request sections" });
  await sections.getByRole("button", { name: /^Files/ }).click();
  const list = pr.getByRole("navigation", { name: "Changed files" });
  check("Files lists the changed files, with the open comment count", await visible(list.getByRole("button", { name: /src\/greeting\.ts/ }))
    && await list.getByRole("button", { name: /src\/greeting\.txt/ }).getByLabel("1 open comment threads").count() === 1);
  const ts = pr.getByRole("region", { name: "src/greeting.ts", exact: true });
  check("the TypeScript diff is highlighted", await until(async () => await ts.locator(".git-review-code span[style*='color']").count() > 0, 20000));
  check("its grammar alone was fetched, once", grammars.length === 1 && grammars[0] === "typescript", grammars);
  check("a text file stays plain", await pr.getByRole("region", { name: "src/greeting.txt", exact: true }).locator(".git-review-code span[style]").count() === 0);
  await pr.getByLabel("Side by side").check();
  check("Side by side shows the two sides", await visible(pr.locator(".git-review-split")));
  await page.screenshot({ path: out + "/pr-parity-files.png", fullPage: false });
  await page.reload({ waitUntil: "load" });
  await visible(pr.getByRole("heading", { name: /Add greeting check/ }), 30000);
  await sections.getByRole("button", { name: /^Files/ }).click();
  check("Side by side is kept over a reload", await visible(pr.locator(".git-review-split")) && await pr.getByLabel("Side by side").isChecked());

  await pr.getByRole("heading", { name: /Add greeting check/ }).click();
  await page.keyboard.press("j");
  const first = await active(page);
  await page.keyboard.press("j");
  const second = await active(page);
  await page.keyboard.press("k");
  const back = await active(page);
  check("j and k step through the files", first.path === "src/greeting.txt" && second.path === "src/greeting.ts" && back.path === "src/greeting.txt", [first, second, back]);
  await page.keyboard.press("n");
  check("n goes to the open comment thread", (await active(page)).thread === "42", await active(page));

  await sections.getByRole("button", { name: /^Comments/ }).click();
  const thread = pr.locator(".git-review-thread", { hasText: "wrold?" });
  check("a thread read away from the diff shows its diff fragment", await visible(thread.locator(".git-review-snippet .git-review-code", { hasText: "wrold" })));
  await thread.getByRole("button", { name: "Show in diff" }).click();
  check("Show in diff opens Files on the thread", await until(async () => await sections.getByRole("button", { name: /^Files/ }).getAttribute("aria-current") === "page"
    && (await active(page)).thread === "42"));


  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "https://github.com/stand-owner/alpha/pull/12";
    link.textContent = "a pull request link";
    link.id = "stand-pr-link";
    link.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;background:#fff;padding:4px";
    document.body.appendChild(link);
  });
  // The overlay reads the accounts on mount and when the window gets the focus.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await until(async () => accountsSeen, 5000);
  await page.locator("#stand-pr-link").click();
  check("a github.com pull request link opens inside Makosh Git", await until(async () => /plugins\/bb-git-dashboard\/git\/pr\/stand-github\/12\/stand-owner\/alpha/.test(decodeURIComponent(page.url()))),
    {url: page.url(), accountsSeen});

  await page.goto(url + "settings/plugins/bb-git-dashboard", { waitUntil: "load" });
  const send = page.getByRole("button", { name: "Send test notification" });
  check("the Notifications settings offer a test notification", await visible(send, 30000));
  await send.click();
  check("it answers how the alert went out", await visible(page.getByRole("status").filter({ hasText: /The alert is in My PRs\./ })));
  await page.goto(url + "plugins/bb-git-dashboard/git/projects", { waitUntil: "load" });
  await page.getByRole("navigation", { name: "Makosh Git" }).getByRole("button", { name: /^My PRs\b/ }).click({ timeout: 30000 });
  check("the test alert is in My PRs", await visible(page.getByText("Test alert from Makosh Git")));

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
