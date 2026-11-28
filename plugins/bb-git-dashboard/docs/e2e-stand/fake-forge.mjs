// HTTPS stand-in for a Gitea server (API v1) with one repository, stand/beta, and its Actions runs.
// Requests must carry the stand token. Every write is appended to $FORGE_LOG as one JSON line.
// Usage: node fake-forge.mjs <cert.pem> <key.pem> <port> <log>
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, join } from "node:path";

const [cert, key, port, log] = process.argv.slice(2);
const origin = "https://localhost:" + port;
const repo = {id: 5, name: "beta", full_name: "stand/beta", clone_url: origin + "/stand/beta.git", default_branch: "main", permissions: {push: true}};
const run = (id, conclusion, title) => ({id, run_number: id, name: "CI", path: ".gitea/workflows/ci.yml", display_title: title, head_branch: "main",
  head_sha: "c".repeat(40), event: "workflow_dispatch", status: "completed", conclusion, run_attempt: 1,
  created_at: "2026-11-27T10:0" + id + ":00Z", updated_at: "2026-11-27T10:0" + id + ":40Z", html_url: origin + "/stand/beta/actions/runs/" + id, actor: {login: "stand"}});
const runs = [run(2, "failure", "Dispatch outcome=failure"), run(1, "success", "Initial push")];
const jobs = {
  1: [{id: 11, name: "build", status: "completed", conclusion: "success", steps: [{number: 1, name: "Checkout", status: "completed", conclusion: "success"}]}],
  2: [{id: 21, name: "build", status: "completed", conclusion: "success", started_at: "2026-11-27T10:02:00Z", completed_at: "2026-11-27T10:02:18Z", steps: []},
      {id: 22, name: "test (2)", status: "completed", conclusion: "failure", started_at: "2026-11-27T10:02:00Z", completed_at: "2026-11-27T10:04:14Z", steps: [{number: 1, name: "Checkout", status: "completed", conclusion: "success"},
        {number: 2, name: "Check greeting", status: "completed", conclusion: "failure"}]}],
};
const lines = Array.from({length: 120}, (_, i) => "2026-11-27T10:02:" + String(i % 60).padStart(2, "0") + ".0000000Z step output " + (i + 1));
lines.splice(90, 0, "2026-11-27T10:02:30.0000000Z ##[error]src/greeting.txt:2: expected \"hello\"");
const workflow = "on:\n  push:\n  workflow_dispatch:\n    inputs:\n      outcome:\n        type: choice\n        options: [success, failure]\n        default: success\n      message:\n        description: Greeting\n";
// Incoming pull requests: #3 is mine with a conflict and failing CI; #4 asks for my review; #1 was merged.
const issue = (number, title, login, state, merged) => ({id: 500 + number, number, title, state, html_url: origin + "/stand/beta/pulls/" + number,
  user: {login}, repository: {full_name: "stand/beta"}, created_at: "2026-11-27T09:0" + number + ":00Z", updated_at: "2026-11-27T11:0" + number + ":00Z",
  closed_at: state === "closed" ? "2026-11-27T10:00:00Z" : null, pull_request: {merged, merged_at: merged ? "2026-11-27T10:00:00Z" : null, draft: false}});
const inbox = {created_open: [issue(3, "[ABC-12] Add greeting check", "stand", "open", false)], review_requested_open: [issue(4, "Tidy README", "alice", "open", false)],
  created_closed: [issue(1, "Initial import", "stand", "closed", true)]};
const pulls = {3: {mergeable: false, additions: 12, deletions: 3, head: {ref: "greeting", sha: "e".repeat(40)}},
  4: {mergeable: true, additions: 2, deletions: 2, head: {ref: "readme", sha: "f".repeat(40)}}};
// Repositories made through the API (scaffolds.mjs): bare repositories served over HTTPS by git http-backend next to
// the write log. Push needs no credential here: a credential request would make git ask the Keychain on the machine
// running the stand (its helper can show a desktop dialog), and the Keychain path is checked live, not on the stand.
const gitRoot = join(dirname(log), "git");
const made = new Map();
const madeRepo = name => ({...repo, id: 100 + [...made.keys()].indexOf(name), name, full_name: "stand/" + name, clone_url: origin + "/stand/" + name + ".git", private: made.get(name).private});
function smartHttp(req, res, path) {
  const backend = spawn("git", ["http-backend"], {env: {...process.env, GIT_PROJECT_ROOT: gitRoot, GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: path, REQUEST_METHOD: req.method, QUERY_STRING: new URL(req.url, origin).search.slice(1),
    CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "stand", REMOTE_ADDR: "127.0.0.1"}});
  req.pipe(backend.stdin);
  let head = Buffer.alloc(0);
  let started = false;
  backend.stdout.on("data", chunk => {
    if (started) return res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    started = true;
    let status = 200;
    for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
      const [key, ...rest] = line.split(":");
      if (key.toLowerCase() === "status") status = Number(rest.join(":").trim().split(" ")[0]);
      else res.setHeader(key, rest.join(":").trim());
    }
    res.writeHead(status);
    res.write(head.subarray(end + 4));
  });
  backend.on("close", () => res.end());
}
// stand/beta over Git once account-write.mjs has made its bare repository: until then (catalog.mjs) it serves no
// Git transport. Its pushes and fetches are logged as writes, so a probe can count them.
const betaBare = () => join(gitRoot, "stand", "beta.git");
const betaServed = () => existsSync(betaBare());
const betaBranch = name => { try { return execFileSync("git", ["-C", betaBare(), "rev-parse", "--verify", "--quiet", "refs/heads/" + name], {encoding: "utf8"}).trim() || null; } catch { return null; } };
// Branches: main, and the ones a new file was committed to (ci-templates.mjs).
const branches = {main: "a".repeat(40)};
const json = (res, status, body) => { res.writeHead(status, {"content-type": "application/json"}); res.end(body === undefined ? "" : JSON.stringify(body)); };

createServer({cert: readFileSync(cert), key: readFileSync(key)}, (req, res) => {
  const url = new URL(req.url, origin);
  const path = url.pathname;
  if (path === "/api/v1/version") return json(res, 200, {version: "1.25.3"});
  const smart = /^\/stand\/([a-z0-9._-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (smart && (made.has(smart[1]) || (smart[1] === "beta" && betaServed()))) {
    // A repository made through the API asks Git for the account's credential, as a real forge does: the first push
    // only goes through when the credential helper has the token for this exact repository.
    if (req.headers.authorization !== "Basic " + Buffer.from("stand:stand-token").toString("base64")) {
      res.writeHead(401, {"www-authenticate": 'Basic realm="stand"'});
      return res.end();
    }
    // A push's receive-pack and a fetch's advertisement (a fetch with nothing new sends no upload-pack).
    if (smart[1] === "beta" && (req.method === "POST" || url.searchParams.get("service") === "git-upload-pack"))
      appendFileSync(log, JSON.stringify({method: req.method, path, git: req.method === "POST" ? smart[2] : "fetch-refs"}) + "\n");
    return smartHttp(req, res, path);
  }
  if (req.headers.authorization !== "token stand-token") return json(res, 401, {message: "token required"});
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    if (req.method !== "GET") {
      appendFileSync(log, JSON.stringify({method: req.method, path, body: body ? JSON.parse(body) : null}) + "\n");
      if (/\/actions\/(workflows\/[^/]+\/dispatches|runs\/\d+\/(rerun|rerun-failed-jobs|cancel))$/.test(path)) return json(res, 204);
      // A CI template's file in a new branch, then its pull request (ci-templates.mjs).
      const file = /^\/api\/v1\/repos\/stand\/beta\/contents\/(.+)$/.exec(path);
      if (req.method === "POST" && file) {
        const input = JSON.parse(body);
        if (branches[input.new_branch] || !branches[input.branch]) return json(res, 422, {message: "branch exists or base missing"});
        branches[input.new_branch] = "d".repeat(40);
        return json(res, 201, {content: {path: decodeURIComponent(file[1])}, commit: {sha: "d".repeat(40), parents: [{sha: branches[input.branch]}]}});
      }
      if (req.method === "POST" && path === "/api/v1/repos/stand/beta/pulls") return json(res, 201, {number: 9});
      if (req.method === "POST" && path === "/api/v1/user/repos") {
        const input = JSON.parse(body);
        if (!/^[a-z0-9._-]+$/.test(input.name) || made.has(input.name)) return json(res, 409, {message: "exists"});
        const bare = join(gitRoot, "stand", input.name + ".git");
        mkdirSync(bare, {recursive: true});
        execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
        execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
        made.set(input.name, {private: input.private === true});
        return json(res, 201, madeRepo(input.name));
      }
      // Deleting a branch (the ci-templates live script's clean-up, run against this stand-in).
      const gone = /^\/api\/v1\/repos\/stand\/beta\/branches\/(.+)$/.exec(path);
      if (req.method === "DELETE" && gone) {
        const name = decodeURIComponent(gone[1]);
        if (!branches[name] || name === "main") return json(res, 404, {message: "not found"});
        delete branches[name];
        return json(res, 204);
      }
      // Deleting one's own discussion comment (pr-parity.mjs).
      if (req.method === "DELETE" && /^\/api\/v1\/repos\/stand\/beta\/issues\/comments\/\d+$/.test(path)) return json(res, 204);
      // Pull request and issue writes of the review probe.
      if (/^\/api\/v1\/repos\/stand\/beta\/(issues(\/\d+\/comments)?|pulls\/\d+(\/(reviews|requested_reviewers|merge|comments\/\d+\/replies))?|issues\/\d+)$|^\/api\/v1\/repos\/stand\/beta\/pulls\/comments\/\d+\/(resolve|unresolve)$/.test(path))
        return json(res, 201, {id: 99, number: 9});
      return json(res, 404, {message: "not found"});
    }
    const r = "/api/v1/repos/stand/beta";
    if (path === "/api/v1/user") return json(res, 200, {login: "stand"});
    // A second repository no working copy has, for the catalog's clone (catalog.mjs).
    if (path === "/api/v1/user/repos") return json(res, 200, [repo, {...repo, id: 6, name: "delta", full_name: "stand/delta", clone_url: origin + "/stand/delta.git"}]);
    if (path === r) return json(res, 200, repo);
    const own = /^\/api\/v1\/repos\/stand\/([a-z0-9._-]+)$/.exec(path);
    if (own && made.has(own[1])) return json(res, 200, madeRepo(own[1]));
    const named = /^\/api\/v1\/repos\/stand\/beta\/branches\/(.+)$/.exec(path);
    if (named) { const head = branches[decodeURIComponent(named[1])] ?? (betaServed() ? betaBranch(decodeURIComponent(named[1])) : null); return head ? json(res, 200, {name: decodeURIComponent(named[1]), commit: {id: head}}) : json(res, 404, {message: "not found"}); }
    if (path === "/api/v1/repos/issues/search") {
      const flag = ["created", "review_requested", "reviewed", "assigned"].find(name => url.searchParams.get(name) === "true");
      const items = inbox[flag + "_" + url.searchParams.get("state")] ?? [];
      res.setHeader("x-total-count", String(items.length));
      return json(res, 200, items.slice(0, Number(url.searchParams.get("limit") ?? 50)));
    }
    const pull = /^\/api\/v1\/repos\/stand\/beta\/pulls\/(\d+)$/.exec(path);
    if (pull && pulls[pull[1]]) {
      const found = inbox.created_open.concat(inbox.review_requested_open).find(item => item.number === Number(pull[1]));
      return json(res, 200, {id: 900 + Number(pull[1]), number: Number(pull[1]), title: found?.title ?? "", body: Number(pull[1]) === 3 ? "Checks the greeting for ABC-12, **carefully**. See https://acme.atlassian.net/browse/ABC-1." : "Checks the greeting.", state: "open", merged: false,
        user: {login: found?.user.login ?? "stand"}, html_url: found?.html_url, changed_files: 1, labels: [], requested_reviewers: [], created_at: found?.created_at,
        ...pulls[pull[1]], base: {ref: "main", repo: {default_branch: "main"}}});
    }
    // The repository's pull requests of every state, as the catalog's "Open pull requests" reads them.
    if (path === r + "/pulls") return json(res, 200, [
      {number: 3, title: "[ABC-12] Add greeting check", body: "", state: "open", head: {ref: "greeting", sha: "e".repeat(40), repo: {full_name: "stand/beta"}},
        base: {ref: "main", sha: "a".repeat(40), repo: {full_name: "stand/beta"}}, updated_at: "2026-11-27T11:03:00Z", merged: false},
      {number: 1, title: "Initial import", body: "", state: "closed", head: {ref: "init", sha: "c".repeat(40), repo: {full_name: "stand/beta"}},
        base: {ref: "main", sha: "a".repeat(40), repo: {full_name: "stand/beta"}}, updated_at: "2026-11-27T10:00:00Z", merged: true}]);
    if (path === r + "/pulls/3/files") return json(res, 200, [{filename: "src/greeting.txt", status: "changed", additions: 1, deletions: 1},
      {filename: "src/greeting.ts", status: "changed", additions: 1, deletions: 1}]);
    if (path === r + "/pulls/3.diff") { res.writeHead(200, {"content-type": "text/plain"});
      return res.end("diff --git a/src/greeting.txt b/src/greeting.txt\n--- a/src/greeting.txt\n+++ b/src/greeting.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+wrold\n" +
        "diff --git a/src/greeting.ts b/src/greeting.ts\n--- a/src/greeting.ts\n+++ b/src/greeting.ts\n@@ -1,2 +1,2 @@\n export const greeting = \"hello\";\n-const target = \"world\";\n+const target = \"wrold\";\n"); }
    if (path === r + "/issues/3/comments") return json(res, 200, [{id: 31, body: "Looks close.", user: {login: "alice"}, created_at: "2026-11-27T10:30:00Z", html_url: origin + "/stand/beta/pulls/3#c31"},
      {id: 32, body: "My own note.", user: {login: "stand"}, created_at: "2026-11-27T10:35:00Z", html_url: origin + "/stand/beta/pulls/3#c32"}]);
    if (path === r + "/pulls/3/reviews") return json(res, 200, [{id: 41, user: {login: "alice"}, state: "REQUEST_CHANGES", body: "Typo on line 2.", submitted_at: "2026-11-27T10:40:00Z"}]);
    if (path === r + "/pulls/3/reviews/41/comments") return json(res, 200, [{id: 42, body: "wrold?", user: {login: "alice"}, path: "src/greeting.txt", position: 2,
      original_position: 2, diff_hunk: "@@ -1,2 +1,2 @@\n hello\n-world\n+wrold", commit_id: "e".repeat(40), created_at: "2026-11-27T10:40:00Z", html_url: origin + "/stand/beta/pulls/3#c42", resolver: null}]);
    if (path === r + "/pulls/3/commits") return json(res, 200, [{sha: "e".repeat(40), commit: {message: "Check the greeting", author: {name: "stand", date: "2026-11-27T09:30:00Z"}}}]);
    if (path === r + "/commits/" + "e".repeat(40) + "/status") return json(res, 200, {state: "failure", statuses: [{context: "ci/test", status: "failure", target_url: origin + "/stand/beta/actions/runs/2"}]});
    if (path === r + "/commits/" + "f".repeat(40) + "/status") return json(res, 200, {state: "success", statuses: [{context: "ci/test", status: "success"}]});
    if (path === r + "/actions/runs") {
      const status = url.searchParams.get("status");
      const items = status === "failure" ? runs.filter(item => item.conclusion === "failure") : status ? [] : runs;
      return json(res, 200, {total_count: items.length, workflow_runs: items});
    }
    const one = /^\/api\/v1\/repos\/stand\/beta\/actions\/runs\/(\d+)(\/jobs)?$/.exec(path);
    if (one) {
      const found = runs.find(item => item.id === Number(one[1]));
      if (!found) return json(res, 404, {message: "not found"});
      return json(res, 200, one[2] ? {total_count: jobs[found.id].length, jobs: jobs[found.id]} : found);
    }
    if (/^\/api\/v1\/repos\/stand\/beta\/actions\/jobs\/\d+\/logs$/.test(path)) { res.writeHead(200, {"content-type": "text/plain"}); return res.end(lines.join("\n") + "\n"); }
    if (path === r + "/actions/workflows") return json(res, 200, {total_count: 1, workflows: [{id: "ci.yml", name: "CI", path: ".gitea/workflows/ci.yml", state: "active"}]});
    if (path === r + "/contents/.gitea/workflows/ci.yml") return json(res, 200, {encoding: "base64", content: Buffer.from(workflow).toString("base64")});
    return json(res, 404, {message: "not found"});
  });
}).listen(Number(port));
