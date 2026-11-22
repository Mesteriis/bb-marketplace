// Run after npm run build. Supply PLAYWRIGHT_CORE (module path) and CHROME (executable) from the isolated stand.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
const root = fileURLToPath(new URL("../../", import.meta.url));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");
const result = await build({
  root,
  configFile: false,
  logLevel: "error",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    target: "es2022",
    lib: { entry: root + "tests/embed-browser/runtime.mjs", formats: ["es"], fileName: "runtime" },
  },
});
const runtime = result[0].output.find((file) => file.type === "chunk").code;
const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  for (const scenario of ["ssh", "rdp", "vnc", "vnc-busy"]) {
    const kind = scenario.split("-")[0];
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (error) => console.error(error.message));
    let socket;
    let connections = 0;
    await page.routeWebSocket("**/http/attach?*", (ws) => {
      socket = ws;
      connections++;
    });
    await page.route("https://remote-hub.test/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/app.js" || pathname === "/app.css") return route.fulfill({ path: root + "dist" + pathname });
      if (pathname === "/runtime.js") return route.fulfill({ contentType: "text/javascript", body: runtime });
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><main data-chertog-embed-layer="v1"><section data-live-host="view-1"><div data-chertog-embed-target="v1" data-instance-id="view-1" data-generation="1"></div></section></main><script type="module" src="/runtime.js"></script></body></html>',
      });
    });
    await page.goto("https://remote-hub.test/?provider=remote-" + kind + "-live");
    await page.getByRole("button", { name: kind.toUpperCase() + " · 7" }).click({ timeout: 8000 });
    await page.waitForFunction(() => fixture.calls.includes("session_attach"));
    for (let i = 0; i < 100 && !socket; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(socket, "the owner opens an attach socket");
    const status = (s) => page.waitForFunction((s) => globalThis.fixture?.replies.at(-1)?.kind === s, s, { timeout: 5000 });
    if (kind === "ssh") {
      socket.send(JSON.stringify({ type: "snapshot", bytes: 3 }));
      socket.send(Buffer.from("abc"));
      socket.send(JSON.stringify({ type: "live" }));
      await status("ready");
      assert.equal(await page.locator(".xterm").count(), 1);
    } else if (kind === "rdp") {
      socket.send(JSON.stringify({ type: "desktop", frameId: 1, width: 2, height: 2 }));
      function band(y) {
        const chunk = Buffer.alloc(44, 255);
        chunk.writeBigUInt64LE(1n, 0);
        [2, 2, 0, y, 2, 1, 2].forEach((n, i) => chunk.writeUInt32LE(n, 8 + 4 * i));
        return chunk;
      }
      socket.send(band(0));
      socket.send(band(1));
      await status("ready");
      const rgba = await page
        .locator("canvas")
        .first()
        .evaluate((c) => [...c.getContext("2d").getImageData(0, 1, 1, 1).data]);
      assert.deepEqual(rgba, [255, 255, 255, 255]);
    } else if (scenario === "vnc") {
      // A local RFB 3.8 server greeting, None security and a 2 × 2 true-colour desktop.
      const desktop = Buffer.from([0, 2, 0, 2, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
      const handshake = [Buffer.from([1, 1]), Buffer.alloc(4), desktop];
      socket.onMessage((message) => {
        if (typeof message !== "string" && handshake.length) socket.send(handshake.shift());
      });
      socket.send(Buffer.from("RFB 003.008\n"));
      await status("ready");
      assert.equal(await page.locator("canvas").count(), 1);
    } else {
      socket.send(JSON.stringify({ type: "error", code: "vnc_view_taken" }));
      await status("denied");
    }
    if (scenario !== "vnc-busy") {
      await page.evaluate(() => {
        fixture.move();
        fixture.send({ kind: "visibility", visible: false });
      });
      await page.locator(".rh-embed[inert]").waitFor({ state: "attached" });
      await page.evaluate(() => fixture.send({ kind: "visibility", visible: true }));
      socket.close({ code: 4410, reason: "helper exited" });
      await status("lost");
    }
    const { calls, replies } = await page.evaluate(() => ({ calls: fixture.calls, replies: fixture.replies }));
    assert.equal(connections, 1);
    assert.equal(calls.filter((m) => m === "session_attach").length, 1);
    assert.ok(
      replies.every((m) =>
        Object.keys(m).every((k) => ["version", "provider", "instanceId", "generation", "kind", "resourceRef"].includes(k)),
      ),
    );
    await page.reload();
    await status("lost");
    assert.equal(await page.evaluate(() => fixture.calls.length), 0);
    assert.equal(connections, 1);
    console.log(scenario + " " + replies.map((m) => m.kind).join(" → ") + "; one attach; reload lost without RPC");
    await page.close();
  }
} finally {
  await browser.close();
}
