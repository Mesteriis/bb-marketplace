// Builds the ChatGPT window app on this Mac and runs it as a child process.
// The window talks to this process only through its standard input and
// output; it opens no port, so nothing else on the machine can drive it
// through the plugin.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseWindowMessage, type PanelView, type WindowMessage } from "../../core/window-protocol.ts";
import { WINDOW_SOURCE } from "./window-source.generated.ts";

export const APP_NAME = "BB Chat Dock.app";
export const BUNDLE_ID = "io.github.mesteriis.bb-chat-dock.window";
const EXECUTABLE = "ChatDockWindow";
// Unanswered scripts are capped, not timed out: the transfer session has its
// own timeout and must still see a late answer to withdraw a stale mark.
const MAX_PENDING = 64;
const BUILD_TIMEOUT_MS = 180_000;

export type RunResult = { code: number | null; stderr: string };
export type Runner = (command: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

export const runCommand: Runner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stderr: "not found" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });

export function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleName</key><string>ChatGPT</string>
<key>CFBundleDisplayName</key><string>ChatGPT</string>
<key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}

export interface BuildOptions {
  dataDir: string;
  tempDir: string;
  run?: Runner;
  source?: string;
  /** Extra compiler flags; tests pass `-D CHAT_DOCK_TEST`. */
  flags?: readonly string[];
}

export type BuildResult = { ok: true; executable: string } | { ok: false; reason: string };

/**
 * Compiles the window once per source version into the plugin's data
 * directory. Needs Xcode or the Command Line Tools (`xcrun swiftc`).
 */
export async function buildWindowApp(options: BuildOptions): Promise<BuildResult> {
  const run = options.run ?? runCommand;
  const source = options.source ?? WINDOW_SOURCE;
  const flags = options.flags ?? [];
  const key = createHash("sha256").update(source).update(flags.join(" ")).digest("hex").slice(0, 16);
  const appDir = join(options.dataDir, "window", key, APP_NAME);
  const executable = join(appDir, "Contents", "MacOS", EXECUTABLE);
  try {
    await access(executable);
    return { ok: true, executable };
  } catch {
    // Not built yet.
  }
  const work = join(options.tempDir, "window-build-" + randomUUID());
  const staged = join(work, APP_NAME);
  try {
    await mkdir(join(staged, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(staged, "Contents", "Info.plist"), infoPlist());
    const file = join(work, "ChatDockWindow.swift");
    await writeFile(file, source);
    const target = (arch() === "x64" ? "x86_64" : "arm64") + "-apple-macos14";
    const result = await run(
      "xcrun",
      ["swiftc", "-O", "-module-cache-path", join(work, "modules"), "-target", target, ...flags, "-o", join(staged, "Contents", "MacOS", EXECUTABLE), file, "-framework", "AppKit", "-framework", "WebKit"],
      BUILD_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      return {
        ok: false,
        reason:
          result.code === null
            ? "Не найден компилятор Swift. Установите Xcode или Command Line Tools (xcode-select --install)."
            : "Окно не собралось. Проверьте Xcode или Command Line Tools.",
      };
    }
    const signed = await run("codesign", ["--force", "--sign", "-", staged], 60_000);
    if (signed.code !== 0) return { ok: false, reason: "Не удалось подписать окно локальной подписью." };
    await mkdir(join(options.dataDir, "window", key), { recursive: true });
    try {
      await rename(staged, appDir);
    } catch (error) {
      // Another worker published the same version first: keep its build.
      try {
        await access(executable);
      } catch {
        throw error;
      }
    }
    return { ok: true, executable };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface RunningWindow {
  evaluate(expression: string): Promise<unknown>;
  showPanel(view: PanelView): void;
  show(): void;
  quit(): void;
  readonly exited: Promise<void>;
}

export interface LaunchOptions {
  executable: string;
  onMessage(message: Exclude<WindowMessage, { type: "result" }>): void;
  env?: NodeJS.ProcessEnv;
  spawnChild?: (executable: string, env: NodeJS.ProcessEnv) => ChildProcess;
}

const defaultSpawn = (executable: string, env: NodeJS.ProcessEnv): ChildProcess =>
  spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"], env });

export function launchWindow(options: LaunchOptions): RunningWindow {
  const child = (options.spawnChild ?? defaultSpawn)(options.executable, options.env ?? process.env);
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let alive = true;

  const exited = new Promise<void>((resolve) => {
    const done = () => {
      if (!alive) return;
      alive = false;
      for (const [id, entry] of pending) {
        entry.reject(new Error("window closed"));
        pending.delete(id);
      }
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });

  if (child.stdout !== null) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = parseWindowMessage(line);
      if (message === null) return;
      if (message.type === "result") {
        const entry = pending.get(message.id);
        if (entry === undefined) return;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error("page script failed"));
        return;
      }
      options.onMessage(message);
    });
  }

  function send(command: Record<string, unknown>): boolean {
    if (!alive || child.stdin === null || child.stdin.destroyed) return false;
    child.stdin.write(JSON.stringify(command) + "\n");
    return true;
  }

  return {
    evaluate(expression) {
      return new Promise((resolve, reject) => {
        if (pending.size >= MAX_PENDING) {
          reject(new Error("too many unanswered scripts"));
          return;
        }
        const id = randomUUID();
        pending.set(id, { resolve, reject });
        if (!send({ type: "evaluate", id, expression })) {
          pending.delete(id);
          reject(new Error("window closed"));
        }
      });
    },
    showPanel(view) {
      send({ type: "panel", ...view });
    },
    show() {
      send({ type: "show" });
    },
    quit() {
      if (!send({ type: "quit" })) return;
      child.stdin?.end();
      // A window that does not quit on its own is stopped.
      setTimeout(() => {
        if (alive) child.kill("SIGTERM");
      }, 3_000).unref?.();
    },
    exited,
  };
}
