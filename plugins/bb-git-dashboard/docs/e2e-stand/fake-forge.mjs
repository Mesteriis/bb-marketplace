// HTTPS stand-in for a Gitea server (API v1) with one repository, stand/beta, and its Actions runs.
// Requests must carry the stand token. Every write is appended to $FORGE_LOG as one JSON line.
// Usage: node fake-forge.mjs <cert.pem> <key.pem> <port> <log>
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:https";

const [cert, key, port, log] = process.argv.slice(2);
const origin = "https://localhost:" + port;
const repo = {id: 5, name: "beta", full_name: "stand/beta", clone_url: origin + "/stand/beta.git", default_branch: "main", permissions: {push: true}};
const run = (id, conclusion, title) => ({id, run_number: id, name: "CI", path: ".gitea/workflows/ci.yml", display_title: title, head_branch: "main",
  head_sha: "c".repeat(40), event: "workflow_dispatch", status: "completed", conclusion, run_attempt: 1,
  created_at: "2026-11-27T10:0" + id + ":00Z", updated_at: "2026-11-27T10:0" + id + ":40Z", html_url: origin + "/stand/beta/actions/runs/" + id, actor: {login: "stand"}});
const runs = [run(2, "failure", "Dispatch outcome=failure"), run(1, "success", "Initial push")];
const jobs = {
  1: [{id: 11, name: "build", status: "completed", conclusion: "success", steps: [{number: 1, name: "Checkout", status: "completed", conclusion: "success"}]}],
  2: [{id: 21, name: "build", status: "completed", conclusion: "success", steps: []},
      {id: 22, name: "test (2)", status: "completed", conclusion: "failure", steps: [{number: 1, name: "Checkout", status: "completed", conclusion: "success"},
        {number: 2, name: "Check greeting", status: "completed", conclusion: "failure"}]}],
};
const lines = Array.from({length: 120}, (_, i) => "2026-11-27T10:02:" + String(i % 60).padStart(2, "0") + ".0000000Z step output " + (i + 1));
lines.splice(90, 0, "2026-11-27T10:02:30.0000000Z ##[error]src/greeting.txt:2: expected \"hello\"");
const workflow = "on:\n  push:\n  workflow_dispatch:\n    inputs:\n      outcome:\n        type: choice\n        options: [success, failure]\n        default: success\n      message:\n        description: Greeting\n";
// Incoming pull requests: #3 is mine with a conflict and failing CI; #4 asks for my review; #1 was merged.
const issue = (number, title, login, state, merged) => ({id: 500 + number, number, title, state, html_url: origin + "/stand/beta/pulls/" + number,
  user: {login}, repository: {full_name: "stand/beta"}, created_at: "2026-11-27T09:0" + number + ":00Z", updated_at: "2026-11-27T11:0" + number + ":00Z",
  closed_at: state === "closed" ? "2026-11-27T10:00:00Z" : null, pull_request: {merged, merged_at: merged ? "2026-11-27T10:00:00Z" : null, draft: false}});
const inbox = {created_open: [issue(3, "Add greeting check", "stand", "open", false)], review_requested_open: [issue(4, "Tidy README", "alice", "open", false)],
  created_closed: [issue(1, "Initial import", "stand", "closed", true)]};
const pulls = {3: {mergeable: false, additions: 12, deletions: 3, head: {ref: "greeting", sha: "e".repeat(40)}},
  4: {mergeable: true, additions: 2, deletions: 2, head: {ref: "readme", sha: "f".repeat(40)}}};
const json = (res, status, body) => { res.writeHead(status, {"content-type": "application/json"}); res.end(body === undefined ? "" : JSON.stringify(body)); };

createServer({cert: readFileSync(cert), key: readFileSync(key)}, (req, res) => {
  const url = new URL(req.url, origin);
  const path = url.pathname;
  if (path === "/api/v1/version") return json(res, 200, {version: "1.25.3"});
  if (req.headers.authorization !== "token stand-token") return json(res, 401, {message: "token required"});
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    if (req.method !== "GET") {
      appendFileSync(log, JSON.stringify({method: req.method, path, body: body ? JSON.parse(body) : null}) + "\n");
      if (/\/actions\/(workflows\/[^/]+\/dispatches|runs\/\d+\/(rerun|rerun-failed-jobs|cancel))$/.test(path)) return json(res, 204);
      // Pull request and issue writes of the review probe.
      if (/^\/api\/v1\/repos\/stand\/beta\/(issues(\/\d+\/comments)?|pulls\/\d+(\/(reviews|requested_reviewers|merge|comments\/\d+\/replies))?|issues\/\d+)$|^\/api\/v1\/repos\/stand\/beta\/pulls\/comments\/\d+\/(resolve|unresolve)$/.test(path))
        return json(res, 201, {id: 99, number: 9});
      return json(res, 404, {message: "not found"});
    }
    const r = "/api/v1/repos/stand/beta";
    if (path === "/api/v1/user") return json(res, 200, {login: "stand"});
    if (path === "/api/v1/user/repos") return json(res, 200, [repo]);
    if (path === r) return json(res, 200, repo);
    if (path === "/api/v1/repos/issues/search") {
      const flag = ["created", "review_requested", "reviewed", "assigned"].find(name => url.searchParams.get(name) === "true");
      const items = inbox[flag + "_" + url.searchParams.get("state")] ?? [];
      res.setHeader("x-total-count", String(items.length));
      return json(res, 200, items.slice(0, Number(url.searchParams.get("limit") ?? 50)));
    }
    const pull = /^\/api\/v1\/repos\/stand\/beta\/pulls\/(\d+)$/.exec(path);
    if (pull && pulls[pull[1]]) {
      const found = inbox.created_open.concat(inbox.review_requested_open).find(item => item.number === Number(pull[1]));
      return json(res, 200, {id: 900 + Number(pull[1]), number: Number(pull[1]), title: found?.title ?? "", body: "Checks the greeting.", state: "open", merged: false,
        user: {login: found?.user.login ?? "stand"}, html_url: found?.html_url, changed_files: 1, labels: [], requested_reviewers: [], created_at: found?.created_at,
        ...pulls[pull[1]], base: {ref: "main", repo: {default_branch: "main"}}});
    }
    if (path === r + "/pulls/3/files") return json(res, 200, [{filename: "src/greeting.txt", status: "changed", additions: 1, deletions: 1}]);
    if (path === r + "/pulls/3.diff") { res.writeHead(200, {"content-type": "text/plain"});
      return res.end("diff --git a/src/greeting.txt b/src/greeting.txt\n--- a/src/greeting.txt\n+++ b/src/greeting.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+wrold\n"); }
    if (path === r + "/issues/3/comments") return json(res, 200, [{id: 31, body: "Looks close.", user: {login: "alice"}, created_at: "2026-11-27T10:30:00Z", html_url: origin + "/stand/beta/pulls/3#c31"}]);
    if (path === r + "/pulls/3/reviews") return json(res, 200, [{id: 41, user: {login: "alice"}, state: "REQUEST_CHANGES", body: "Typo on line 2.", submitted_at: "2026-11-27T10:40:00Z"}]);
    if (path === r + "/pulls/3/reviews/41/comments") return json(res, 200, [{id: 42, body: "wrold?", user: {login: "alice"}, path: "src/greeting.txt", position: 2,
      original_position: 2, commit_id: "e".repeat(40), created_at: "2026-11-27T10:40:00Z", html_url: origin + "/stand/beta/pulls/3#c42", resolver: null}]);
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
