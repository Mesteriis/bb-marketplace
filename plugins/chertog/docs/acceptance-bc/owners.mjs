// Stand-only owner transports. Never forward a fixture request to a service.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const [url, tools, executablePath] = process.argv.slice(2);
assert.equal(new URL(url).hostname, "127.0.0.1");
assert(!["38886", "38887", ""].includes(new URL(url).port));
const { chromium } = createRequire(tools + "/")("playwright-core");
const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  const meeting = { id: "123456789", topic: "Fixture Zoom" };
  const session = { generation: "a".repeat(32), sessionId: 7, state: "running", kind: "ssh", reason: null };
  const sessions = [
    session,
    { ...session, sessionId: 8, kind: "rdp", rdp: { state: "desktop_ready", desktop: { frameId: 1, width: 2, height: 2 } } },
    { ...session, sessionId: 9, kind: "vnc" },
  ];
  const calls = [];
  const zoom = {
    meetings_list: { meetings: [meeting] },
    embed_select: "12345678-1234-4123-8123-123456789abc",
    embed_resolve: meeting,
    embed_prepare: { meetingNumber: meeting.id, passcode: null, userName: "Fixture",
      signature: "fixture", zak: "fixture", fallbackUrl: "about:blank" },
  };
  const remote = {
    agent_sessions: [], session_list: sessions,
  };
  for (const [plugin, replies] of [["zoom", zoom], ["remote-hub", remote]]) {
    await page.route("**/api/v1/plugins/makosh-" + plugin + "/rpc/*", route => {
      const method = new URL(route.request().url()).pathname.split("/").pop();
      calls.push(method);
      if (method === "session_resource_ref" || method === "session_attach") {
        const { sessionId, liveKind } = route.request().postDataJSON();
        assert(sessions.some(item => item.sessionId === sessionId && item.kind === liveKind));
        const result = method === "session_attach" ? { token: liveKind } : { resourceRef: "12345678-1234-4123-8123-123456789ab" + sessionId };
        return route.fulfill({ json: { ok: true, result } });
      }
      return route.fulfill({ json: Object.hasOwn(replies, method)
        ? { ok: true, result: replies[method] } : { ok: false, error: "Unavailable on fixture" } });
    });
  }
  let sockets = 0;
  await page.routeWebSocket("**/makosh-remote-hub/http/attach?*", ws => {
    sockets++;
    const kind = new URL(ws.url()).searchParams.get("attach");
    if (kind === "rdp") {
      ws.send(JSON.stringify({ type: "desktop", frameId: 1, width: 2, height: 2 }));
      for (const y of [0, 1]) {
        const chunk = Buffer.alloc(44, 255);
        chunk.writeBigUInt64LE(1n, 0);
        [2, 2, 0, y, 2, 1, 2].forEach((n, i) => chunk.writeUInt32LE(n, 8 + 4 * i));
        ws.send(chunk);
      }
      return;
    }
    if (kind === "vnc") {
      const desktop = Buffer.from([3,32,2,88,32,24,0,1,0,255,0,255,0,255,16,8,0,0,0,0,0,0,0,0]);
      const handshake = [Buffer.from([1,1]), Buffer.alloc(4), desktop];
      ws.onMessage(msg => {
        if (typeof msg !== "string" && handshake.length) ws.send(handshake.shift());
      });
      ws.send(Buffer.from("RFB 003.008\n"));
      return;
    }
    assert.equal(kind, "ssh");
    ws.send(JSON.stringify({ type: "snapshot", bytes: 3 }));
    ws.send(Buffer.from("abc"));
    ws.send(JSON.stringify({ type: "live" }));
  });
  await page.addInitScript(() => {
    window.readyProviders = [];
    document.addEventListener("chertog.embed.v1.owner", e => {
      if (e.detail.kind === "ready") window.readyProviders.push(e.detail.provider);
    });
  });
  const parentOrigin = new URL(url).origin;
  await page.route("**/makosh-zoom/http/call", route => route.fulfill({
    contentType: "text/html",
    body: `<body><output>waiting</output><script>
      const origin = ${JSON.stringify(parentOrigin)};
      let joins = 0;
      addEventListener("message", e => {
        if (e.origin !== origin || e.source !== parent) return;
        if (e.data.type === "zoom-call:loaded") parent.postMessage({type:"zoom-call:ready"}, origin);
        if (e.data.type === "zoom-call:join") {
          document.querySelector("output").textContent = "joined " + ++joins;
          parent.postMessage({type:"zoom-call:joined"}, origin);
        }
      });
    </script></body>`,
  }));
  await page.goto(new URL("/plugins/chertog/home", url).href);
  async function choose(kind, name) {
    await page.getByRole("button", { name: "Добавить панель", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Добавить вид " + kind, exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
  }
  await choose("Zoom", meeting.topic);
  const hosts = page.locator("[data-live-host]");
  await hosts.getByRole("heading", { name: meeting.topic }).waitFor();
  await hosts.getByRole("button", { name: "Войти в звонок" }).waitFor();
  assert(!calls.includes("embed_prepare"));
  await hosts.getByRole("button", { name: "Войти в звонок" }).click();
  const iframe = page.locator('iframe[src*="makosh-zoom/http/call"]');
  const joined = iframe.contentFrame().getByText("joined 1", { exact: true });
  await joined.waitFor();
  const zoomNode = await iframe.elementHandle();
  await choose("SSH", "SSH · 7");
  await hosts.locator(".xterm").waitFor();
  await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("abc") || document.querySelector(".xterm-screen canvas"));
  for (const [kind, id] of [["rdp", 8], ["vnc", 9]]) {
    await choose(kind.toUpperCase(), kind.toUpperCase() + " · " + id);
    await page.waitForFunction(name => window.readyProviders.includes(name), "remote-" + kind + "-live", { timeout: 10000 });
  }
  assert.equal(sockets, 3);
  assert.equal(calls.filter(method => method === "session_attach").length, 3);
  assert.equal(calls.filter(method => method === "embed_prepare").length, 1);
  assert(!calls.some(method => ["session_connect","session_close"].includes(method)));
  assert(await zoomNode.evaluate(el => el.isConnected));
  assert.equal(await joined.count(), 1);
  console.log("PASS explicit synthetic Zoom join: same iframe and one join after adding three Remote Hub tiles");
  console.log("PASS Zoom invitation, SSH xterm, ready RDP and VNC in installed owner tiles at 1280x800; three attach calls/sockets, zero remote connect/close");
} finally {
  await browser.close();
}
