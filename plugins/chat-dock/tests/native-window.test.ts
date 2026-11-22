import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME, BUNDLE_ID, buildWindowApp, infoPlist, launchWindow, type Runner } from "../src/adapters/bb/native-window.ts";
import { WINDOW_SOURCE } from "../src/adapters/bb/window-source.generated.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-dock-test-"));
  dirs.push(dir);
  return dir;
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  written: string[] = [];
  killed: string[] = [];
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.written.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
  }
  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }
  say(object: unknown) {
    this.stdout.write(JSON.stringify(object) + "\n");
  }
}

function launch() {
  const child = new FakeChild();
  const messages: unknown[] = [];
  const window = launchWindow({
    executable: "/fake/ChatDockWindow",
    onMessage: (message) => void messages.push(message),
    spawnChild: () => child as unknown as ChildProcess,
  });
  return { child, messages, window };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the embedded window source", () => {
  it("matches native/ChatDockWindow.swift", () => {
    expect(WINDOW_SOURCE).toBe(readFileSync(new URL("../native/ChatDockWindow.swift", import.meta.url), "utf8"));
  });

  it("keeps the site fixed and the inspector off", () => {
    expect(WINDOW_SOURCE).toContain('URL(string: "https://chatgpt.com/")!');
    expect(WINDOW_SOURCE).toContain("webView.isInspectable = false");
    expect(WINDOW_SOURCE).toContain("WKWebsiteDataStore(forIdentifier: dataStoreID)");
    // Test hooks exist only inside compile-time test blocks.
    const outside = WINDOW_SOURCE.replace(/#if CHAT_DOCK_TEST[\s\S]*?#endif/g, "");
    expect(outside).not.toContain("test-press");
    expect(outside).not.toContain("CHAT_DOCK_TEST_HTML");
  });
});

describe("building the window app", () => {
  it("compiles once into the data directory, signs it locally, and reuses it", async () => {
    const calls: string[][] = [];
    const run: Runner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "xcrun") {
        const out = args[args.indexOf("-o") + 1]!;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(out, "binary");
      }
      return { code: 0, stderr: "" };
    };
    const dataDir = tempDir();
    const options = { dataDir, tempDir: tempDir(), run, source: "// source" };

    const first = await buildWindowApp(options);
    const second = await buildWindowApp(options);

    expect(first.ok && second.ok && first.executable === second.executable).toBe(true);
    expect(first.ok && first.executable.includes(join(APP_NAME, "Contents", "MacOS", "ChatDockWindow"))).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(["xcrun", "codesign"]);
    expect(calls[0]).toEqual(expect.arrayContaining(["swiftc", "-framework", "AppKit", "-framework", "WebKit"]));
    expect(calls[1]).toEqual(expect.arrayContaining(["--sign", "-"]));
    expect(first.ok && readFileSync(join(first.executable, "..", "..", "Info.plist"), "utf8")).toContain(BUNDLE_ID);
  });

  it("names the missing compiler and leaves nothing half-built", async () => {
    const dataDir = tempDir();
    const result = await buildWindowApp({ dataDir, tempDir: tempDir(), run: async () => ({ code: null, stderr: "not found" }), source: "x" });

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("xcode-select --install") });
    expect(existsSync(join(dataDir, "window"))).toBe(false);
  });

  it("declares the bundle the window's data store lives under", () => {
    expect(infoPlist()).toContain("<key>CFBundleIdentifier</key><string>io.github.mesteriis.bb-chat-dock.window</string>");
    expect(infoPlist()).toContain("<key>LSMinimumSystemVersion</key><string>14.0</string>");
  });
});

describe("the running window", () => {
  it("answers page scripts by id and ignores lines it does not know", async () => {
    const { child, window, messages } = launch();
    const answer = window.evaluate("1 + 1");
    await tick();
    const sent = JSON.parse(child.written[0]!) as { type: string; id: string; expression: string };
    expect(sent).toMatchObject({ type: "evaluate", expression: "1 + 1" });

    child.say({ type: "result", id: "someone-else", ok: true, value: 3 });
    child.stdout.write("garbage\n");
    child.say({ type: "result", id: sent.id, ok: true, value: { status: "handed-off" } });

    await expect(answer).resolves.toEqual({ status: "handed-off" });
    expect(messages).toEqual([]);
  });

  it("forwards the user's presses and addresses", async () => {
    const { child, messages } = launch();
    child.say({ type: "url", url: "https://chatgpt.com/c/abc" });
    child.say({ type: "pressed", action: "insert" });
    await tick();

    expect(messages).toEqual([
      { type: "url", url: "https://chatgpt.com/c/abc" },
      { type: "pressed", action: "insert" },
    ]);
  });

  it("fails pending scripts when the window exits, and sends nothing after", async () => {
    const { child, window } = launch();
    const answer = window.evaluate("x");
    child.emit("exit", 0);

    await expect(answer).rejects.toThrow("window closed");
    await window.exited;
    await expect(window.evaluate("y")).rejects.toThrow("window closed");
    expect(child.written).toHaveLength(1);
  });

  it("sends the panel and asks the window to quit", async () => {
    const { child, window } = launch();
    window.showPanel({ visible: true, status: "s", text: "t", canInsert: true, canRebind: false, canCopy: true, busy: false, dismissLabel: "Отмена" });
    window.quit();
    await tick();

    expect(child.written.map((line) => JSON.parse(line).type)).toEqual(["panel", "quit"]);
  });
});
