// HTTPS stand-in for a self-managed GitLab (API v4) with one project, stand/gamma: pipelines, jobs, a job trace
// with section markers and colours, the CI file, issues and CI/CD variables. Requests must carry the stand token.
// Every write is appended to $LOG as one JSON line.
// Usage: node fake-gitlab.mjs <cert.pem> <key.pem> <port> <log>
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:https";

const [cert, key, port, log] = process.argv.slice(2);
const origin = "https://localhost:" + port;
const web = origin + "/stand/gamma";
const project = {id: 7, name: "gamma", path_with_namespace: "stand/gamma", namespace: {full_path: "stand"}, http_url_to_repo: web + ".git",
  default_branch: "main", ci_config_path: null, web_url: web};
const pipeline = (id, status, source) => ({id, iid: id - 100, status, ref: "main", sha: "d".repeat(40), source, name: null,
  created_at: "2026-11-27T11:0" + (id - 100) + ":00Z", updated_at: "2026-11-27T11:0" + (id - 100) + ":40Z", web_url: web + "/-/pipelines/" + id, user: {username: "stand"}});
const pipelines = [pipeline(103, "running", "push"), pipeline(102, "failed", "web"), pipeline(101, "success", "schedule")];
const job = (id, name, stage, status) => ({id, name, stage, status, started_at: "2026-11-27T11:02:00Z",
  finished_at: status === "running" ? null : "2026-11-27T11:02:30Z", web_url: web + "/-/jobs/" + id, failure_reason: status === "failed" ? "script_failure" : undefined});
const jobs = {101: [job(1011, "build", "build", "success")], 102: [job(1021, "build", "build", "success"), job(1022, "unit", "test", "failed")],
  103: [job(1031, "build", "build", "running")]};
const trace = ["\u001b[0KRunning with gitlab-runner 17.5.0", "section_start:1764241320:step_script\r\u001b[0K\u001b[32;1m$ make test\u001b[0;m",
  ...Array.from({length: 60}, (_, i) => "test output " + (i + 1)), "\u001b[31;1mERROR: src/greeting.txt:2: expected \"hello\"\u001b[0;m",
  ...Array.from({length: 8}, (_, i) => "cleanup " + (i + 1)), "section_end:1764241350:step_script\r\u001b[0K", "\u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m"];
const config = "spec:\n  inputs: {}\n---\nvariables:\n  DEPLOY_ENV:\n    value: staging\n    options: [staging, production]\n    description: Where to deploy\n" +
  "  INTERNAL:\n    value: x\nunit:\n  stage: test\n  script: [make test]\n";
const issues = [{iid: 4, title: "Greeting is wrong", state: "opened", labels: ["bug"], updated_at: "2026-11-27T11:00:00Z", web_url: web + "/-/issues/4"}];
const variables = [{key: "DEPLOY_TOKEN", value: "stand-variable-value", variable_type: "env_var", protected: true, masked: true, environment_scope: "*"}];
const json = (res, status, body, headers = {}) => { res.writeHead(status, {"content-type": "application/json", ...headers}); res.end(body === undefined ? "" : JSON.stringify(body)); };
const text = (res, body) => { res.writeHead(200, {"content-type": "text/plain"}); res.end(body); };

createServer({cert: readFileSync(cert), key: readFileSync(key)}, (req, res) => {
  const url = new URL(req.url, origin);
  // The path keeps %2F: GitLab addresses a project by its encoded full path.
  const path = req.url.split("?")[0];
  if (path === "/api/v4/version") return req.headers.authorization ? json(res, 200, {version: "17.5.0", revision: "stand"}) : json(res, 401, {message: "401 Unauthorized"});
  if (req.headers.authorization !== "Bearer stand-gitlab-token") return json(res, 401, {message: "401 Unauthorized"});
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    const p = "/api/v4/projects/7";
    if (req.method === "POST") {
      appendFileSync(log, JSON.stringify({method: req.method, path, body: body ? JSON.parse(body) : null}) + "\n");
      if (path === p + "/pipeline") return json(res, 201, pipeline(104, "created", "api"));
      const one = /^\/api\/v4\/projects\/7\/pipelines\/(\d+)\/(retry|cancel)$/.exec(path);
      if (one) return json(res, 201, pipelines.find(item => item.id === Number(one[1])) ?? {});
      return json(res, 404, {message: "404 Not found"});
    }
    if (path === "/api/v4/user") return json(res, 200, {id: 1, username: "stand"});
    if (path === "/api/v4/projects") return json(res, 200, [project], {"x-next-page": ""});
    if (path === p || path === "/api/v4/projects/stand%2Fgamma") return json(res, 200, project);
    if (path === p + "/pipelines") {
      const scope = url.searchParams.get("scope"), status = url.searchParams.get("status");
      const items = pipelines.filter(item => (!scope || item.status === scope) && (!status || item.status === status));
      return json(res, 200, items, {"x-next-page": ""});
    }
    const one = /^\/api\/v4\/projects\/7\/pipelines\/(\d+)(\/jobs)?$/.exec(path);
    if (one) {
      const found = pipelines.find(item => item.id === Number(one[1]));
      return found ? json(res, 200, one[2] ? [...jobs[found.id]].reverse() : found) : json(res, 404, {message: "404 Not found"});
    }
    const jobPath = /^\/api\/v4\/projects\/7\/jobs\/(\d+)(\/trace)?$/.exec(path);
    if (jobPath) {
      const found = Object.values(jobs).flat().find(item => item.id === Number(jobPath[1]));
      if (!found) return json(res, 404, {message: "404 Not found"});
      return jobPath[2] ? text(res, found.id === 1022 ? trace.join("\n") + "\n" : "$ make\nok\n") : json(res, 200, found);
    }
    if (path === p + "/repository/files/.gitlab-ci.yml/raw") return text(res, config);
    if (path === p + "/issues") return json(res, 200, issues, {"x-next-page": ""});
    if (path === p + "/variables") return json(res, 200, variables);
    if (path === p + "/merge_requests") return json(res, 200, [], {"x-next-page": ""});
    return json(res, 404, {message: "404 Not found"});
  });
}).listen(Number(port));
