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
const json = (res, status, body) => { res.writeHead(status, {"content-type": "application/json"}); res.end(body === undefined ? "" : JSON.stringify(body)); };

createServer({cert: readFileSync(cert), key: readFileSync(key)}, (req, res) => {
  const url = new URL(req.url, origin);
  const path = url.pathname;
  if (path === "/api/v1/version") return json(res, 200, {version: "1.25.3"});
  if (req.headers.authorization !== "token stand-token") return json(res, 401, {message: "token required"});
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    if (req.method === "POST") {
      appendFileSync(log, JSON.stringify({method: req.method, path, body: body ? JSON.parse(body) : null}) + "\n");
      if (/\/actions\/(workflows\/[^/]+\/dispatches|runs\/\d+\/(rerun|rerun-failed-jobs|cancel))$/.test(path)) return json(res, 204);
      return json(res, 404, {message: "not found"});
    }
    const r = "/api/v1/repos/stand/beta";
    if (path === "/api/v1/user") return json(res, 200, {login: "stand"});
    if (path === "/api/v1/user/repos") return json(res, 200, [repo]);
    if (path === r) return json(res, 200, repo);
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
