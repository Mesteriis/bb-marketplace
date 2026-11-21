// The one HTTP route of the plugin: the controlled frame page and nothing
// else. Requests go through a real router with exact-path matching.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readLiveFrameFixture, registerLiveFrameRoute } from "../../../src/adapters/bb/server/index.ts";
import { FakeHttp, FakeLog } from "./support.ts";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixture = readFileSync(join(pluginRoot, "assets", "fixtures", "live-frame.html"), "utf8");

function mounted(html: string | null = fixture): { http: FakeHttp; log: FakeLog } {
  const http = new FakeHttp();
  const log = new FakeLog();
  registerLiveFrameRoute({ http, log }, html);
  return { http, log };
}

describe("live frame route", () => {
  it("registers one GET route with the host's default local-origin check", () => {
    const { http, log } = mounted();
    expect(http.routes).toEqual([{ method: "GET", path: "/fixtures/live-frame.html", auth: undefined }]);
    expect(log.lines).toEqual([]);
  });

  it("returns the fixture page", async () => {
    const response = await mounted().http.request("/fixtures/live-frame.html");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(fixture);
    expect(body).toContain("<title>Chertog live frame fixture</title>");
  });

  it("lets a BB window embed the page and gives the page no network", async () => {
    const response = await mounted().http.request("/fixtures/live-frame.html");
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    expect(headers).toEqual({
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*; " +
        "style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  });

  it("returns the same page whatever the query asks for", async () => {
    const { http } = mounted();
    for (const query of ["?instance=tile-2", "?file=../../package.json", "?path=/etc/passwd", "?file=..%2F..%2Fpackage.json"]) {
      const response = await http.request("/fixtures/live-frame.html" + query);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(fixture);
    }
  });

  it("serves no other path, with or without directory steps", async () => {
    const { http } = mounted();
    const paths = [
      "/",
      "/fixtures",
      "/fixtures/",
      "/fixtures/live-frame.html/",
      "/fixtures/other.html",
      "/fixtures/live-frame.htm",
      "/fixtures/%2e%2e/package.json",
      "/fixtures/..%2F..%2Fpackage.json",
      "/fixtures/live-frame.html/..%2F..%2F..%2Fpackage.json",
      "/fixtures/live-frame.html%2F..%2F..%2Fpackage.json",
      "/assets/fixtures/live-frame.html",
      "/assets/icon.svg",
      "/package.json",
      "/server.ts",
    ];
    for (const path of paths) {
      const response = await http.request(path);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).not.toContain("bb-plugin-chertog");
    }
  });

  it("serves the page to GET only", async () => {
    const { http } = mounted();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect([method, (await http.request("/fixtures/live-frame.html", method)).status]).toEqual([method, 404]);
    }
  });

  it("answers 404 and says so in the log when the installation has no fixture", async () => {
    const { http, log } = mounted(null);
    const response = await http.request("/fixtures/live-frame.html");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("The live frame fixture is not part of this installation");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(log.lines).toEqual(["warn live frame: assets/fixtures/live-frame.html was not found; the route answers 404"]);
  });
});

describe("reading the fixture from the package", () => {
  it("finds it next to server.ts in a checkout", () => {
    expect(readLiveFrameFixture(pathToFileURL(join(pluginRoot, "server.ts")).href)).toBe(fixture);
  });

  it("finds it one directory above the built dist/server.js", () => {
    expect(readLiveFrameFixture(pathToFileURL(join(pluginRoot, "dist", "server.js")).href)).toBe(fixture);
  });

  it("returns null when the package has no fixture", () => {
    const empty = mkdtempSync(join(tmpdir(), "chertog-no-fixture-"));
    try {
      expect(readLiveFrameFixture(pathToFileURL(join(empty, "dist", "server.js")).href)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true });
    }
  });
});
