import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UiRoutes, serveUiFile } from "./ui-http.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function ui(): string {
  const d = mkdtempSync(join(tmpdir(), "gw-ui-"));
  dirs.push(d);
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), '<!doctype html>\n<html lang="en">\n  <head>\n    <title>GitWand</title>\n  </head>\n</html>\n');
  writeFileSync(join(d, "assets/app.js"), "console.log(1)");
  return d;
}

describe("serveUiFile", () => {
  it("serves index.html with the shim loaded first and a loopback-only frame policy", async () => {
    const r = await serveUiFile(ui(), "index.html");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors http://127.0.0.1:* http://localhost:*");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toBe(
      '<!doctype html>\n<html lang="en">\n  <head>\n    <script src="/api/v1/plugins/makosh-gitwand/http/gw/shim.js"></script>\n    <title>GitWand</title>\n  </head>\n</html>\n',
    );
  });

  it("serves an asset with its type", async () => {
    const r = await serveUiFile(ui(), "assets/app.js");
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await r.text()).toBe("console.log(1)");
  });

  it("answers 404 for a file the current runtime does not have", async () => {
    expect((await serveUiFile(ui(), "assets/old-hash.js")).status).toBe(404);
  });

  it("answers 503 with an explanation when no runtime is installed", async () => {
    const r = await serveUiFile(null, "index.html");
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("The GitWand runtime is not installed");
  });
});

describe("UiRoutes", () => {
  it("registers one GET route per new file, and each only once", () => {
    const registered: string[] = [];
    const routes = new UiRoutes((path) => registered.push(path), async () => null);
    routes.ensure(["index.html", "assets/a.js"]);
    routes.ensure(["index.html", "assets/b.js", "../escape.js"]);
    expect(registered).toEqual(["/ui/index.html", "/ui/assets/a.js", "/ui/assets/b.js"]);
    expect(routes.count).toBe(3);
  });
});
