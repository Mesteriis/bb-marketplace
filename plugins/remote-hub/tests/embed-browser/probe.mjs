// Run after npm run build. Supply PLAYWRIGHT_CORE (module path) and CHROME (executable) from the isolated stand.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
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
async function until(check, description) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), description);
}
// Exercise the owner's mounted viewer without changing the window or opening another socket.
async function measureReadyViewer(page, kind, terminalSizes) {
  const selector = kind === "ssh" ? ".xterm" : "canvas";
  for (const [width, height] of [[640, 400], [360, 220]]) {
    await page.locator("[data-chertog-embed-target]").evaluate((el, size) => {
      el.style.width = size.width + "px";
      el.style.height = size.height + "px";
    }, { width, height });

    await page.waitForFunction(({ selector, width, height, kind }) => {
      const widget = document.querySelector(selector).getBoundingClientRect();
      const body = document.querySelector(".rh-agent-body").getBoundingClientRect();
      const target = document.querySelector("[data-chertog-embed-target]").getBoundingClientRect();
      // Allow the control badge above the viewer. The viewer must fit inside the tile.
      if (body.width !== width || body.height < height - 80 || body.bottom > target.bottom + 1) return false;
      const scale = Math.min((body.width - 2) / 800, (body.height - 2) / 600);
      const expectedWidth = kind === "vnc" ? 800 * scale : body.width;
      const expectedHeight = kind === "vnc" ? 600 * scale : body.height;
      return Math.abs(widget.width - expectedWidth) <= 3 && Math.abs(widget.height - expectedHeight) <= 3;
    }, { selector, width, height, kind }, { timeout: 3000 }).catch(async cause => {
      const box = await page.locator(selector).boundingBox();
      throw new Error(kind + " in " + width + "×" + height + ": " + JSON.stringify(box), { cause });
    });
    const box = await page.locator(selector).boundingBox();
    console.log(kind + " in " + width + "×" + height + ": " + box.width + "×" + box.height);
    if (kind === "ssh" && width === 640) await until(() => terminalSizes.length > 0, "SSH initial size");
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  for (const scenario of ["vnc", "ssh", "rdp", "vnc-release", "vnc-close", "vnc-busy"]) {
    const kind = scenario.split("-")[0];
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (error) => console.error(error.message));
    let socket;
    let connections = 0;
    let detaches = 0;
    let disconnected = false;
    const input = [];
    const pointerEvents = [];
    const terminalSizes = [];
    function observe(message) {
      if (typeof message !== "string") return;
      const frame = JSON.parse(message);
      if (frame.type === "input") input.push(...frame.events);
      if (frame.type === "resize") terminalSizes.push(frame);
      if (frame.type === "detach") detaches++;
    }
    await page.routeWebSocket("**/http/attach?*", (ws) => {
      socket = ws;
      connections++;
      ws.onMessage(observe);
      ws.onClose(() => { disconnected = true; });
    });
    await page.route("https://remote-hub.test/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/app.js" || pathname === "/app.css") return route.fulfill({ path: root + "dist" + pathname });
      if (pathname === "/runtime.js") return route.fulfill({ contentType: "text/javascript", body: runtime });
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><main data-chertog-embed-layer="v1"><section data-live-host="view-1"><div style="width:640px;height:400px" data-chertog-embed-target="v1" data-instance-id="view-1" data-generation="1"></div></section></main><script type="module" src="/runtime.js"></script></body></html>',
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
      await page.locator("canvas").evaluate(canvas => {
        const box = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new MouseEvent("mousedown", {bubbles:true,button:0,clientX:box.x+box.width/2,clientY:box.y+box.height/2}));
        for (const code of ["ShiftLeft","ControlLeft"]) canvas.dispatchEvent(new KeyboardEvent("keydown",{code,bubbles:true}));
      });
      await until(() => input.some(e => e.kind === "key" && e.scancode === 29 && e.down), "RDP key-down reached the peer");
      await page.locator("canvas").evaluate(canvas => {
        canvas.dispatchEvent(new KeyboardEvent("keyup",{code:"ShiftLeft",bubbles:true}));
        fixture.send({kind:"visibility",visible:false});
        canvas.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyX",bubbles:true}));
      });
      await until(() => input.some(e => e.kind === "mouse_button" && !e.down), "RDP released the held mouse before hiding");
      const sequence = input.filter(e => e.kind !== "mouse_move").map(e => [e.scancode ?? e.button,e.down]);
      assert.deepEqual(sequence,[["left",true],[42,true],[29,true],[42,false],[29,false],["left",false]]);
      console.log("RDP hide: queued Shift up, held Ctrl up and left button up received in order");
      await page.evaluate(() => fixture.send({kind:"visibility",visible:true}));
    } else if (kind === "vnc" && scenario !== "vnc-busy") {
      // A local RFB 3.8 server greeting, None security and an 800 × 600 true-colour desktop.
      const desktop = Buffer.from([3, 32, 2, 88, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
      const handshake = [Buffer.from([1, 1]), Buffer.alloc(4), desktop];
      socket.onMessage((message) => {
        observe(message);
        if (typeof message === "string") return;
        if (handshake.length) socket.send(handshake.shift());
        else if (message[0] === 5) {
          pointerEvents.push({ mask: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4) });
        }
      });
      socket.send(Buffer.from("RFB 003.008\n"));
      await status("ready");
      // A raw white pixel in the top left of the remote desktop.
      socket.send(Buffer.from([0,0,0,1, 0,0,0,0, 0,1,0,1, 0,0,0,0, 255,255,255,0]));
      await page.waitForFunction(() => document.querySelector("canvas")?.getContext("2d").getImageData(0,0,1,1).data[0] === 255);

    } else {
      socket.send(JSON.stringify({ type: "error", code: "vnc_view_taken" }));
      await status("denied");
    }
    if (scenario === kind) {
      await measureReadyViewer(page, kind, terminalSizes);
      if (kind === "vnc") {
        await page.locator("canvas").click();
        await until(() => pointerEvents.some(e => e.mask === 1) && pointerEvents.at(-1)?.mask === 0, "RFB pointer down/up reached the console");
        const press = pointerEvents.find(e => e.mask === 1);
        assert.ok(Math.abs(press.x - 400) <= 4 && Math.abs(press.y - 300) <= 4, "centre click maps to the remote centre");
        console.log("VNC centre click reached the guest at " + press.x + "," + press.y);
      }
      if (kind === "ssh") {
        await until(() => terminalSizes.some(s => s.cols > terminalSizes.at(-1).cols && s.rows > terminalSizes.at(-1).rows), "SSH resized its rows and columns");
      }
    }
    if (scenario === "vnc-release") {
      await page.evaluate(() => {
        fixture.send({kind:"release"});
        fixture.send({kind:"release"});
      });
      await until(() => disconnected, "VNC viewer closed its socket before document reload");
      assert.equal(detaches,1);
      assert.equal(await page.locator(".rh-embed").count(),0);
      console.log("VNC release: portal removed, one detach, socket closed");
    } else if (scenario === "vnc-close") {
      await page.evaluate(() => fixture.send({kind:"close"}));
      await page.getByRole("alertdialog").waitFor();
      assert.equal(await page.evaluate(() => fixture.calls.includes("session_close")), false);
      await page.getByRole("button", {name:"Завершить консоль"}).click();
      await status("ended");
      await page.evaluate(() => fixture.send({kind:"release"}));
      assert.equal(await page.evaluate(() => fixture.calls.filter(m => m === "session_close").length), 1);
    } else if (scenario !== "vnc-busy") {
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
