// Checks the controlled live iframe page used for stage A acceptance
// (docs/spec.md, section 5, row "Живая iframe-панель").
//
// How the page reaches BB. `bb plugin build` bundles only server.ts and
// app.tsx into dist/; it copies no assets. BB loads the plugin from its
// package directory, so assets/fixtures/live-frame.html ships as a file of the
// package, next to assets/icon.svg. The SDK has no static asset URL for a
// plugin: to show the page in an iframe, the server must return it from one of
// the plugin's own HTTP routes (`bb.http`, served under
// /api/v1/plugins/chertog/http/*), reading this file from the package
// directory. That route belongs to the slice that mounts the panel and is not
// registered here.
//
// The scaffold has no jsdom, so the page is read as text and its single inline
// script runs in a node:vm context against a hand-made window and document.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pagePath = resolve(pluginRoot, "assets", "fixtures", "live-frame.html");
const page = existsSync(pagePath) ? readFileSync(pagePath, "utf8") : "";

const inlineScripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
const script = inlineScripts[0] ?? "";

interface FakeElement {
  textContent: string;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  dateTime: string;
}

interface Posted {
  message: Record<string, unknown>;
  targetOrigin: string;
}

interface BootOptions {
  /** Bytes the fake crypto hands out, in order. */
  randomBytes: number[];
  local?: Map<string, string>;
  session?: Map<string, string>;
  search?: string;
  /** "blocked": reading window.localStorage or sessionStorage throws, as in an opaque origin. */
  storage?: "blocked";
  /** "none": the page is the top window, window.parent is the window itself. */
  parent?: "none";
}

interface Frame {
  parent: object;
  posted: Posted[];
  element(id: string): FakeElement;
  fire(type: string, event: object): void;
}

function fakeStorage(items: Map<string, string>) {
  return {
    getItem: (key: string): string | null => items.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      items.set(key, value);
    },
  };
}

/** Runs the page script once, as one load of the frame. */
function boot(options: BootOptions): Frame {
  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    let found = elements.get(id);
    if (found === undefined) {
      found = { textContent: "", value: "", selectionStart: 0, selectionEnd: 0, dateTime: "" };
      elements.set(id, found);
    }
    return found;
  };
  const listeners = new Map<string, Array<(event: object) => void>>();
  const posted: Posted[] = [];
  const parent = {
    postMessage: (message: Record<string, unknown>, targetOrigin: string): void => {
      posted.push({ message, targetOrigin });
    },
  };
  const bytes = [...options.randomBytes];
  const local = fakeStorage(options.local ?? new Map());
  const session = fakeStorage(options.session ?? new Map());
  const blocked = (): never => {
    throw new Error("SecurityError");
  };

  const window: Record<string, unknown> = {
    location: { search: options.search ?? "" },
    URLSearchParams,
    crypto: {
      getRandomValues: (target: Uint8Array): Uint8Array => {
        for (let index = 0; index < target.length; index += 1) {
          const next = bytes.shift();
          if (next === undefined) throw new Error("the test supplied too few random bytes");
          target[index] = next;
        }
        return target;
      },
    },
    addEventListener: (type: string, listener: (event: object) => void): void => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  Object.defineProperty(window, "localStorage", { get: options.storage === "blocked" ? blocked : () => local });
  Object.defineProperty(window, "sessionStorage", { get: options.storage === "blocked" ? blocked : () => session });
  window.parent = options.parent === "none" ? window : parent;

  runInNewContext(script, { window, document: { getElementById: element } });

  return {
    parent,
    posted,
    element,
    fire: (type, event) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

const ZERO_TO_FIFTEEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const ALL_255 = new Array<number>(16).fill(255);
const PROBE = { type: "chertog-fixture:probe" };

describe("live-frame.html as a file", () => {
  it("exists where the package ships its assets", () => {
    expect(existsSync(pagePath)).toBe(true);
    const manifest = JSON.parse(readFileSync(resolve(pluginRoot, "package.json"), "utf8")) as { files?: string[] };
    // No "files" list ships the whole package directory; a list must name assets.
    if (manifest.files !== undefined) expect(manifest.files).toContain("assets");
  });

  it("names no external URL and loads nothing", () => {
    expect(page).not.toMatch(/https?:/i);
    expect(page).not.toMatch(/(?:wss?|ftp|data|blob):/i);
    expect(page).not.toMatch(/["'(=\s]\/\/[\w.-]/);
    expect(page).not.toMatch(/\s(?:src|href|srcset|action|poster|data|formaction)\s*=/i);
    expect(page).not.toMatch(/@import|url\(/i);
    expect(page).not.toMatch(/<(?:link|img|iframe|object|embed|video|audio|source|form|base)\b/i);
    expect(page).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/);
    expect(page).not.toMatch(/\bimport\s*\(/);
  });

  it("forbids the network to the browser as well", () => {
    expect(page).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`,
    );
  });

  it("has one inline script and no other script tag", () => {
    expect(inlineScripts).toHaveLength(1);
    expect(page.match(/<script\b/gi)).toHaveLength(1);
  });

  it("answers the probe, makes the boot ID from crypto and runs no timer", () => {
    expect(script).toContain('"chertog-fixture:"');
    expect(script).toContain('PREFIX + "probe"');
    expect(script).toContain('PREFIX + "state"');
    expect(script).toContain("crypto.getRandomValues");
    expect(script).not.toMatch(/Math\.random|setInterval|setTimeout|requestAnimationFrame/);
  });

  it("leaves the caret to the DOM", () => {
    expect(script).not.toMatch(/setSelectionRange|\.selectionStart\s*=[^=]|\.selectionEnd\s*=[^=]|\.focus\(/);
    expect(script).not.toMatch(/\.value\s*=[^=]/);
    expect(page).toMatch(/<textarea\b[^>]*\bid="input"/);
  });

  it("styles through CSS variables with fallbacks, for both themes", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? "";
    expect(style).toContain("color-scheme: light dark");
    expect(style).toContain("@media (prefers-color-scheme: dark)");
    const uses = style.match(/var\(--chertog-fixture-[a-z-]+[^)]*\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const use of uses) expect(use).toMatch(/^var\(--chertog-fixture-[a-z-]+,\s*var\(--_[a-z-]+\)$/);
  });
});

describe("live-frame.html when it loads", () => {
  it("shows a boot ID made from the random bytes of this load", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN });
    expect(frame.element("boot-id").textContent).toBe("000102030405060708090a0b0c0d0e0f");
  });

  it("makes a different boot ID on the next load", () => {
    const local = new Map<string, string>();
    const session = new Map<string, string>();
    boot({ randomBytes: ZERO_TO_FIFTEEN, local, session });
    const second = boot({ randomBytes: ALL_255, local, session });
    expect(second.element("boot-id").textContent).toBe("ffffffffffffffffffffffffffffffff");
  });

  it("counts loads in both storages and shows the counts", () => {
    const local = new Map<string, string>();
    const session = new Map<string, string>();
    const first = boot({ randomBytes: ZERO_TO_FIFTEEN, local, session });
    expect(first.element("load-count").textContent).toBe("1");
    expect(first.element("session-load-count").textContent).toBe("1");

    const second = boot({ randomBytes: ALL_255, local, session });
    expect(second.element("load-count").textContent).toBe("2");
    expect(second.element("session-load-count").textContent).toBe("2");
    expect(local.get("chertog-fixture:default:loads")).toBe("2");
    expect(session.get("chertog-fixture:default:loads")).toBe("2");

    const newSession = boot({ randomBytes: ALL_255, local, session: new Map() });
    expect(newSession.element("load-count").textContent).toBe("3");
    expect(newSession.element("session-load-count").textContent).toBe("1");
  });

  it("starts from one when a stored count is not a number", () => {
    const local = new Map([["chertog-fixture:default:loads", "garbage"]]);
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, local });
    expect(frame.element("load-count").textContent).toBe("1");
  });

  it("keeps the counters of two instances apart", () => {
    const local = new Map<string, string>();
    boot({ randomBytes: ZERO_TO_FIFTEEN, local, search: "?instance=left" });
    boot({ randomBytes: ALL_255, local, search: "?instance=left" });
    const right = boot({ randomBytes: ALL_255, local, search: "?instance=right" });
    expect(local.get("chertog-fixture:left:loads")).toBe("2");
    expect(local.get("chertog-fixture:right:loads")).toBe("1");
    expect(right.element("instance").textContent).toBe("right");
  });

  it("refuses an instance name that is not a plain identifier", () => {
    const local = new Map<string, string>();
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, local, search: "?instance=a%3Ab%20c" });
    expect(frame.element("instance").textContent).toBe("default");
    expect([...local.keys()]).toEqual(["chertog-fixture:default:loads"]);
  });

  it("shows the load time as an ISO timestamp", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN });
    expect(frame.element("loaded-at").textContent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(frame.element("loaded-at").dateTime).toBe(frame.element("loaded-at").textContent);
  });

  it("says so when storage is blocked instead of showing a count", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, storage: "blocked" });
    expect(frame.element("load-count").textContent).toBe("unavailable");
    expect(frame.element("session-load-count").textContent).toBe("unavailable");
    expect(frame.element("destroy-count").textContent).toBe("unavailable");
    expect(frame.element("boot-id").textContent).toBe("000102030405060708090a0b0c0d0e0f");
  });
});

describe("live-frame.html probe", () => {
  it("answers the parent with the state of this load", () => {
    const local = new Map([["chertog-fixture:default:destroys", "4"]]);
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, local });
    const input = frame.element("input");
    input.value = "hello world";
    input.selectionStart = 3;
    input.selectionEnd = 7;

    frame.fire("message", { source: frame.parent, origin: "app://bb", data: PROBE });

    expect(frame.posted).toHaveLength(1);
    expect(frame.posted[0]?.targetOrigin).toBe("app://bb");
    const { loadedAt, ...state } = frame.posted[0]?.message ?? {};
    expect(state).toEqual({
      type: "chertog-fixture:state",
      bootId: "000102030405060708090a0b0c0d0e0f",
      loadCount: 1,
      sessionLoadCount: 1,
      destroyCount: 4,
      instance: "default",
      text: "hello world",
      selectionStart: 3,
      selectionEnd: 7,
    });
    expect(loadedAt).toBe(frame.element("loaded-at").textContent);
  });

  it("reads the text and caret again on every probe", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN });
    const input = frame.element("input");
    frame.fire("message", { source: frame.parent, origin: "app://bb", data: PROBE });
    input.value = "ab";
    input.selectionStart = 2;
    input.selectionEnd = 2;
    frame.fire("message", { source: frame.parent, origin: "app://bb", data: PROBE });

    expect(frame.posted.map((entry) => entry.message.text)).toEqual(["", "ab"]);
    expect(frame.posted.map((entry) => entry.message.selectionStart)).toEqual([0, 2]);
    expect(frame.posted.map((entry) => entry.message.bootId)).toEqual([
      "000102030405060708090a0b0c0d0e0f",
      "000102030405060708090a0b0c0d0e0f",
    ]);
  });

  it("answers a parent of an opaque origin, which has no origin to name", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN });
    frame.fire("message", { source: frame.parent, origin: "null", data: PROBE });
    expect(frame.posted[0]?.targetOrigin).toBe("*");
  });

  it("reports null counts when storage is blocked", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, storage: "blocked" });
    frame.fire("message", { source: frame.parent, origin: "app://bb", data: PROBE });
    expect(frame.posted[0]?.message.loadCount).toBe(null);
    expect(frame.posted[0]?.message.sessionLoadCount).toBe(null);
    expect(frame.posted[0]?.message.destroyCount).toBe(null);
  });

  it("does not answer a window that is not its parent", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN });
    const stranger = { postMessage: (): void => expect.unreachable("the stranger was answered") };
    frame.fire("message", { source: stranger, origin: "app://bb", data: PROBE });
    frame.fire("message", { source: null, origin: "app://bb", data: PROBE });
    expect(frame.posted).toEqual([]);
  });

  it("does not answer itself when it is the top window", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, parent: "none" });
    const self = { postMessage: (): void => expect.unreachable("the page answered itself") };
    frame.fire("message", { source: self, origin: "app://bb", data: PROBE });
    expect(frame.posted).toEqual([]);
  });

  it("ignores every message that is not the probe", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN });
    for (const data of [null, undefined, "chertog-fixture:probe", 7, {}, { type: "chertog-fixture:state" }, { type: "probe" }]) {
      frame.fire("message", { source: frame.parent, origin: "app://bb", data });
    }
    expect(frame.posted).toEqual([]);
  });
});

describe("live-frame.html when it is destroyed", () => {
  it("counts one destruction once, though pagehide and unload both fire", () => {
    const local = new Map<string, string>();
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, local });
    expect(frame.element("destroy-count").textContent).toBe("0");
    expect(local.has("chertog-fixture:default:destroys")).toBe(false);

    frame.fire("pagehide", { persisted: false });
    frame.fire("unload", {});
    expect(local.get("chertog-fixture:default:destroys")).toBe("1");
  });

  it("counts unload alone", () => {
    const local = new Map<string, string>();
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, local });
    frame.fire("unload", {});
    expect(local.get("chertog-fixture:default:destroys")).toBe("1");
  });

  it("does not count a page kept for back-forward cache", () => {
    const local = new Map<string, string>();
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, local });
    frame.fire("pagehide", { persisted: true });
    expect(local.has("chertog-fixture:default:destroys")).toBe(false);
  });

  it("adds to the destructions of earlier loads and shows them on the next load", () => {
    const local = new Map<string, string>();
    boot({ randomBytes: ZERO_TO_FIFTEEN, local }).fire("pagehide", { persisted: false });
    const second = boot({ randomBytes: ALL_255, local });
    expect(second.element("destroy-count").textContent).toBe("1");
    second.fire("pagehide", { persisted: false });
    expect(local.get("chertog-fixture:default:destroys")).toBe("2");
  });

  it("survives blocked storage", () => {
    const frame = boot({ randomBytes: ZERO_TO_FIFTEEN, storage: "blocked" });
    expect(() => frame.fire("pagehide", { persisted: false })).not.toThrow();
  });
});
