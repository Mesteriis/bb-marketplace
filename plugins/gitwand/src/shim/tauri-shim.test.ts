// @vitest-environment jsdom
// Contract tests of the __TAURI_INTERNALS__ shim, driven through the same
// @tauri-apps packages (and versions) the GitWand UI bundles.
import { Channel, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWN_PLUGIN_COMMANDS } from "../core/tauri-plugin-commands.ts";
import { installTauriShim } from "./tauri-shim.ts";

const BASE = "/api/v1/plugins/makosh-gitwand/http/gw/";
const ORIGIN = "http://localhost:3000";
const PARENT = "http://127.0.0.1:3000";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

type Route = (body: unknown) => { status?: number; json: unknown };
let routes: Record<string, Route>;
let requests: { url: string; method: string; body: unknown }[];
let clipboard: string;
let reloads: number;
let posted: { message: unknown; origin: string }[];

const flush = () => new Promise((r) => setTimeout(r, 0));
const ws = () => FakeWebSocket.instances.at(-1)!;
function hello(conn = "c-1") {
  ws().open();
  ws().receive({ type: "hello", conn });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  routes = { "POST invoke": () => ({ json: { ok: "done" } }) };
  requests = [];
  clipboard = "";
  reloads = 0;
  posted = [];
  localStorage.clear();
  history.replaceState(null, "", "/api/v1/plugins/makosh-gitwand/http/ui/index.html");
  Object.assign(window, { WebSocket: FakeWebSocket });
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, body });
    const route = routes[`${method} ${url.slice(url.indexOf(BASE) + BASE.length)}`];
    if (!route) return new Response("{}", { status: 404 });
    const r = route(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => clipboard, writeText: async (t: string) => void (clipboard = t) },
  });
  vi.spyOn(window, "postMessage").mockImplementation(((message: unknown, origin: string) => void posted.push({ message, origin })) as never);
  installTauriShim(window, { base: BASE, reload: () => void reloads++ });
});

afterEach(() => vi.restoreAllMocks());

describe("installation", () => {
  it("provides the internals @tauri-apps/api reads, with a main window", () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__;
    expect(internals.metadata).toEqual({ currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } });
    expect(typeof (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: unknown } }).__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener).toBe("function");
  });

  it("connects its WebSocket to the relay on the page's own origin", () => {
    expect(ws().url).toBe("ws://localhost:3000/api/v1/plugins/makosh-gitwand/http/gw/ws");
  });

  it("opens ?repo= as the active tab, keeping the tabs already open", () => {
    localStorage.setItem("gitwand-open-tabs", JSON.stringify({ paths: ["/a"], activePath: "/a" }));
    history.replaceState(null, "", "/ui/index.html?repo=%2Ftmp%2Frepo%20a");
    installTauriShim(window, { base: BASE, reload: () => {} });
    expect(JSON.parse(localStorage.getItem("gitwand-open-tabs")!)).toEqual({ paths: ["/a", "/tmp/repo a"], activePath: "/tmp/repo a" });
  });

  it("does not open a repository twice", () => {
    localStorage.setItem("gitwand-open-tabs", JSON.stringify({ paths: ["/r", "/a"], activePath: "/a" }));
    history.replaceState(null, "", "/ui/index.html?repo=%2Fr");
    installTauriShim(window, { base: BASE, reload: () => {} });
    expect(JSON.parse(localStorage.getItem("gitwand-open-tabs")!)).toEqual({ paths: ["/r", "/a"], activePath: "/r" });
  });

  it("replaces unreadable saved tabs instead of failing", () => {
    localStorage.setItem("gitwand-open-tabs", "{broken");
    history.replaceState(null, "", "/ui/index.html?repo=%2Fr");
    installTauriShim(window, { base: BASE, reload: () => {} });
    expect(JSON.parse(localStorage.getItem("gitwand-open-tabs")!)).toEqual({ paths: ["/r"], activePath: "/r" });
  });
});

describe("commands", () => {
  it("posts the command and its arguments to the relay and returns the value", async () => {
    routes["POST invoke"] = () => ({ json: { ok: { branch: "main" } } });
    expect(await invoke("git_status", { cwd: "/r" })).toEqual({ branch: "main" });
    expect(requests).toEqual([{ url: `${ORIGIN}${BASE}invoke`, method: "POST", body: { cmd: "git_status", args: { cwd: "/r" } } }]);
  });

  it("names the page's connection once the relay has greeted it", async () => {
    hello("c-7");
    await invoke("git_status", { cwd: "/r" });
    expect(requests[0].body).toEqual({ cmd: "git_status", args: { cwd: "/r" }, conn: "c-7" });
  });

  it("rejects with the command's own error", async () => {
    routes["POST invoke"] = () => ({ json: { error: "not a git repository" } });
    await expect(invoke("git_status", { cwd: "/r" })).rejects.toBe("not a git repository");
  });

  it("rejects with the relay's reason when the bridge is unavailable", async () => {
    routes["POST invoke"] = () => ({ status: 503, json: { error: "The GitWand runtime is not installed" } });
    await expect(invoke("git_status", {})).rejects.toBe("The GitWand runtime is not installed");
  });
});

describe("channels", () => {
  it("waits for the connection, sends the channel reference and delivers messages in order", async () => {
    const got: unknown[] = [];
    const channel = new Channel<{ type: string; data: string }>();
    channel.onmessage = (m) => got.push(m.data);
    const call = invoke("terminal_open", { cwd: "/r", onOutput: channel });
    await flush();
    expect(requests).toEqual([]);
    hello("c-1");
    routes["POST invoke"] = () => ({ json: { ok: 1 } });
    await flush();
    await flush();
    expect(await call).toBe(1);
    expect(requests[0].body).toEqual({ cmd: "terminal_open", args: { cwd: "/r", onOutput: `__CHANNEL__:${channel.id}` }, conn: "c-1" });
    ws().receive({ channel: channel.id, message: { type: "chunk", data: "a" } });
    ws().receive({ channel: channel.id, message: { type: "chunk", data: "b" } });
    expect(got).toEqual(["a", "b"]);
  });

  it("keeps channels apart and ignores ids it does not know", () => {
    const one: unknown[] = [];
    const two: unknown[] = [];
    const a = new Channel<string>((m) => one.push(m));
    const b = new Channel<string>((m) => two.push(m));
    hello();
    ws().receive({ channel: 9999, message: "lost" });
    ws().receive({ channel: b.id, message: "to b" });
    ws().receive({ channel: a.id, message: "to a" });
    expect(one).toEqual(["to a"]);
    expect(two).toEqual(["to b"]);
  });

  it("tells the BB page when the bridge is lost", () => {
    hello();
    ws().receive({ type: "lost", reason: "gitwand-bridge exited (code 1)" });
    expect(posted).toEqual([{ message: { source: "gitwand", type: "lost", reason: "gitwand-bridge exited (code 1)" }, origin: PARENT }]);
  });
});

const NULL = { value: null };
const REFUSED_IMAGE = { error: "Images are not available in GitWand inside BB" };
/** One row per Tauri plugin command the UI bundle names (src/core/tauri-plugin-commands.ts). */
const CONTRACT: Record<string, { args?: Record<string, unknown>; value?: unknown; error?: string; check?: (v: unknown) => void }> = {
  "clipboard-manager|clear": NULL,
  "clipboard-manager|read_image": { error: "Clipboard images are not available in GitWand inside BB" },
  "clipboard-manager|read_text": { value: "" },
  "clipboard-manager|write_html": { error: "HTML clipboard is not available in GitWand inside BB" },
  "clipboard-manager|write_image": { error: "Clipboard images are not available in GitWand inside BB" },
  "clipboard-manager|write_text": { args: { text: "x" }, value: null },
  "dialog|open": { args: { options: { directory: false } }, error: "Only folders can be picked in GitWand inside BB" },
  "event|emit": { args: { event: "e", payload: 1 }, value: null },
  "event|emit_to": { args: { target: { kind: "Any" }, event: "e", payload: 1 }, value: null },
  "event|listen": { args: { event: "e", target: { kind: "Any" }, handler: 1 }, check: (v) => expect(typeof v).toBe("number") },
  "event|unlisten": { args: { event: "e", eventId: 1 }, value: null },
  "image|from_bytes": REFUSED_IMAGE,
  "image|from_path": REFUSED_IMAGE,
  "image|new": REFUSED_IMAGE,
  "image|rgba": REFUSED_IMAGE,
  "image|size": REFUSED_IMAGE,
  "menu|append": NULL,
  "menu|create_default": { check: (v) => expect(v).toEqual([expect.any(Number), expect.any(String)]) },
  "menu|get": NULL,
  "menu|insert": NULL,
  "menu|is_checked": { value: false },
  "menu|is_enabled": { value: true },
  "menu|items": { value: [] },
  "menu|new": { check: (v) => expect(v).toEqual([expect.any(Number), expect.any(String)]) },
  "menu|popup": NULL,
  "menu|prepend": NULL,
  "menu|remove": NULL,
  "menu|remove_at": NULL,
  "menu|set_accelerator": NULL,
  "menu|set_as_app_menu": NULL,
  "menu|set_as_help_menu_for_nsapp": NULL,
  "menu|set_as_window_menu": NULL,
  "menu|set_as_windows_menu_for_nsapp": NULL,
  "menu|set_checked": NULL,
  "menu|set_enabled": NULL,
  "menu|set_icon": NULL,
  "menu|set_text": NULL,
  "menu|text": { value: "" },
  "notification|is_permission_granted": { value: true },
  "notification|notify": { args: { options: { title: "Pushed", body: "main → origin" } }, value: null },
  "notification|request_permission": { value: "granted" },
  "process|exit": NULL,
  "process|restart": NULL,
  "resources|close": { args: { rid: 1 }, value: null },
  "updater|check": NULL,
  "updater|download": { error: "GitWand inside BB installs updates with downloadAndInstall only" },
  "updater|download_and_install": { error: "No GitWand update is pending" },
  "updater|install": { error: "GitWand inside BB installs updates with downloadAndInstall only" },
};

describe("Tauri plugin commands", () => {
  it("covers every command the UI bundle names", () => {
    expect(Object.keys(CONTRACT).sort()).toEqual([...KNOWN_PLUGIN_COMMANDS].sort());
  });

  it.each(Object.entries(CONTRACT))("answers plugin:%s", async (name, row) => {
    routes["GET update"] = () => ({ json: { update: null } });
    routes["POST update/install"] = () => ({ status: 409, json: { error: "No GitWand update is pending" } });
    const call = invoke(`plugin:${name}`, row.args ?? {});
    if (row.error !== undefined) await expect(call).rejects.toBe(row.error);
    else if (row.check) row.check(await call);
    else expect(await call).toEqual(row.value);
  });

  it("refuses a command it does not know", async () => {
    await expect(invoke("plugin:fs|read_file", {})).rejects.toBe("GitWand inside BB does not support plugin:fs|read_file");
  });
});

describe("plugin behaviour", () => {
  it("copies and pastes through the browser clipboard", async () => {
    await writeText("copied sha");
    expect(clipboard).toBe("copied sha");
    expect(await readText()).toBe("copied sha");
  });

  it("asks the BB page for a folder and returns its answer", async () => {
    const pick = invoke("plugin:dialog|open", { options: { directory: true, multiple: false } });
    await flush();
    expect(posted).toEqual([{ message: { source: "gitwand", type: "pick-folder", id: 1 }, origin: PARENT }]);
    window.dispatchEvent(new MessageEvent("message", { origin: "http://evil.example", data: { source: "gitwand-host", type: "pick-folder-result", id: 1, path: "/evil" } }));
    window.dispatchEvent(new MessageEvent("message", { origin: PARENT, data: { source: "gitwand-host", type: "pick-folder-result", id: 1, path: "/picked" } }));
    expect(await pick).toBe("/picked");
  });

  it("hands notifications to the BB page", async () => {
    await invoke("plugin:notification|notify", { options: { title: "Pushed", body: "main → origin" } });
    expect(posted).toEqual([{ message: { source: "gitwand", type: "notify", title: "Pushed", body: "main → origin" }, origin: PARENT }]);
  });

  it("delivers emitted events to the page's own listeners until they unlisten", async () => {
    const got: unknown[] = [];
    const unlisten = await listen<{ a: number }>("custom", (e) => got.push([e.event, e.payload]));
    await emit("custom", { a: 1 });
    unlisten();
    await emit("custom", { a: 2 });
    expect(got).toEqual([["custom", { a: 1 }]]);
  });

  it("reloads the page on process restart", async () => {
    await invoke("plugin:process|restart");
    expect(reloads).toBe(1);
  });

  it("reports an available update and installs it with progress events", async () => {
    routes["GET update"] = () => ({ json: { update: { version: "3.14.0+bb2", currentVersion: "3.14.0+bb1", date: null, body: "Fixes" } } });
    routes["POST update/install"] = () => ({ json: { ok: { version: "3.14.0+bb2" } } });
    const update = await check();
    expect(update).toMatchObject({ version: "3.14.0+bb2", currentVersion: "3.14.0+bb1", body: "Fixes" });
    const events: string[] = [];
    await update!.downloadAndInstall((e) => events.push(e.event));
    expect(events).toEqual(["Started", "Finished"]);
    expect(requests.at(-1)).toMatchObject({ method: "POST", url: `${ORIGIN}${BASE}update/install`, body: { version: "3.14.0+bb2" } });
  });

  it("finds no update when the plugin offers none", async () => {
    routes["GET update"] = () => ({ json: { update: null } });
    expect(await check()).toBeNull();
  });
});
