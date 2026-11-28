// A stand-in GitHub for the templates repository: api.github.com (the branch with its ETag, the tarball redirect) and
// codeload.github.com (the archive), behind an HTTP CONNECT proxy that the stand's BB is pointed at
// (NODE_USE_ENV_PROXY=1, HTTPS_PROXY). The proxy tunnels those two hosts here and refuses every other one, so nothing
// leaves the machine. The archive is `git archive` of a templates repository's HEAD.
// Usage: node fake-github.mjs <cert.pem> <key.pem> <https port> <proxy port> <control port> <templates repo> <log>
// Control (127.0.0.1, for the probes): GET /state; POST /advance (a new head, the same files); POST /broken (a new
// head whose archive is not gzip); POST /mode/<normal|offline|limited>; GET /requests (what was asked, with whether
// an Authorization header came — never its value).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";

const [cert, key, port, proxyPort, controlPort, repo, log] = process.argv.slice(2);
const repository = "stand/templates";
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
const archiveOf = sha => execFileSync("git", ["-C", repo, "archive", "--format=tar.gz", "--prefix=stand-templates-" + sha.slice(0, 7) + "/", "HEAD"]);
const state = {head, mode: "normal", revisions: new Map([[head, archiveOf(head)]]), committedAt: "2026-11-28T10:00:00Z"};
const requests = [];
const note = entry => { requests.push(entry); appendFileSync(log, JSON.stringify(entry) + "\n"); };
const json = (response, status, value, headers = {}) => { response.writeHead(status, {"content-type": "application/json", ...headers}); response.end(JSON.stringify(value)); };

createServer({cert: readFileSync(cert), key: readFileSync(key)}, (request, response) => {
  const host = (request.headers.host ?? "").replace(/:\d+$/, "");
  const path = new URL(request.url, "https://" + host).pathname;
  note({host, path, auth: Boolean(request.headers.authorization), ifNoneMatch: request.headers["if-none-match"] ?? null});
  if (state.mode === "limited" && !request.headers.authorization)
    return json(response, 403, {message: "API rate limit exceeded"}, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600)});
  if (host === "api.github.com") {
    const branch = /^\/repos\/([^/]+\/[^/]+)\/branches\/([^/]+)$/.exec(path);
    if (branch) {
      if (branch[1] !== repository || decodeURIComponent(branch[2]) !== "main") return json(response, 404, {message: "Branch not found"});
      const etag = "W/\"" + state.head + "\"";
      if (request.headers["if-none-match"] === etag) { response.writeHead(304, {etag}); return response.end(); }
      return json(response, 200, {name: "main", commit: {sha: state.head, commit: {committer: {date: state.committedAt}}}}, {etag});
    }
    const tarball = /^\/repos\/([^/]+\/[^/]+)\/tarball\/([a-f0-9]{40})$/.exec(path);
    if (tarball && tarball[1] === repository && state.revisions.has(tarball[2])) {
      response.writeHead(302, {location: "https://codeload.github.com/" + repository + "/legacy.tar.gz/" + tarball[2]});
      return response.end();
    }
    return json(response, 404, {message: "Not Found"});
  }
  if (host === "codeload.github.com") {
    const sha = /^\/stand\/templates\/legacy\.tar\.gz\/([a-f0-9]{40})$/.exec(path)?.[1];
    const archive = sha && state.revisions.get(sha);
    if (archive) { response.writeHead(200, {"content-type": "application/x-gzip"}); return response.end(archive); }
  }
  response.writeHead(404); response.end();
}).listen(Number(port), "127.0.0.1");

// The proxy: CONNECT to api.github.com or codeload.github.com goes to the stand-in, anything else is refused.
const proxy = createHttp((request, response) => { note({proxy: "refused", target: request.url}); response.writeHead(403); response.end(); });
proxy.on("connect", (request, socket) => {
  const [host, targetPort] = (request.url ?? "").split(":");
  if (!["api.github.com", "codeload.github.com"].includes(host) || targetPort !== "443" || state.mode === "offline") {
    note({proxy: "refused", target: request.url, offline: state.mode === "offline"});
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstream = connect(Number(port), "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.pipe(socket); socket.pipe(upstream); });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
proxy.listen(Number(proxyPort), "127.0.0.1");

const nextSha = label => createHash("sha1").update(label + ":" + state.revisions.size).digest("hex");
createHttp((request, response) => {
  if (request.method === "GET" && request.url === "/state") return json(response, 200, {head: state.head, mode: state.mode, repository});
  if (request.method === "GET" && request.url === "/requests") return json(response, 200, requests);
  if (request.method === "POST" && request.url === "/advance") {
    const sha = nextSha("advance");
    state.revisions.set(sha, archiveOf(head)); state.head = sha; state.committedAt = "2026-11-28T11:00:00Z";
    return json(response, 200, {head: sha});
  }
  if (request.method === "POST" && request.url === "/broken") {
    const sha = nextSha("broken");
    state.revisions.set(sha, Buffer.from("not an archive")); state.head = sha;
    return json(response, 200, {head: sha});
  }
  const mode = /^\/mode\/(normal|offline|limited)$/.exec(request.url ?? "")?.[1];
  if (request.method === "POST" && mode) { state.mode = mode; return json(response, 200, {mode}); }
  json(response, 404, {});
}).listen(Number(controlPort), "127.0.0.1");
console.log("fake GitHub on " + port + ", proxy " + proxyPort + ", control " + controlPort + ", head " + head);
