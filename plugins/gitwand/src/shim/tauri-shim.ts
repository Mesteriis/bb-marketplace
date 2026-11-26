// window.__TAURI_INTERNALS__ for the GitWand UI inside BB.
//
// The UI runs in its desktop mode: every command goes to the plugin's relay
// (POST <base>invoke), channel messages arrive on the page's WebSocket
// (<base>ws), and Tauri plugin commands are answered here or by the BB page
// that embeds the iframe (postMessage to the sibling loopback origin).
//
// installTauriShim must stay self-contained: the server serializes it with
// Function.prototype.toString() into the script the page loads, so it may not
// reference imports or anything outside its own body.

export interface ShimConfig {
  /** The relay's path, ending in "/", e.g. "/api/v1/plugins/makosh-gitwand/http/gw/". */
  base: string;
  /** How process|restart reloads the page (tests replace it). */
  reload?: () => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function installTauriShim(win: any, cfg: ShimConfig): void {
  const loc = win.location;
  const base = new URL(cfg.base, loc.href);
  const reload = cfg.reload ?? (() => loc.reload());
  const parentOrigin = (() => {
    const u = new URL(loc.origin);
    u.hostname = u.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
    return u.origin;
  })();
  const toParent = (message: Record<string, unknown>) => win.parent.postMessage({ source: "gitwand", ...message }, parentOrigin);
  const fail = (message: string) => Promise.reject(message);

  // ?repo= opens that repository as the active tab, before the app reads its tabs.
  const repo = new URLSearchParams(loc.search).get("repo");
  if (repo) {
    let paths: string[] = [];
    try {
      const saved = JSON.parse(win.localStorage.getItem("gitwand-open-tabs") ?? "null");
      if (saved && Array.isArray(saved.paths)) paths = saved.paths.filter((p: unknown) => typeof p === "string");
    } catch {
      paths = [];
    }
    if (!paths.includes(repo)) paths.push(repo);
    win.localStorage.setItem("gitwand-open-tabs", JSON.stringify({ paths, activePath: repo }));
  }

  // Callbacks and channels, as @tauri-apps/api/core expects them.
  const callbacks = new Map<number, (data: unknown) => unknown>();
  const channelIndex = new Map<number, number>();
  let nextCallback = 1;
  const transformCallback = (callback?: (data: unknown) => unknown, once = false) => {
    const id = nextCallback++;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return callback?.(data);
    });
    return id;
  };
  const deliver = (channel: number, message: unknown) => {
    const index = channelIndex.get(channel) ?? 0;
    channelIndex.set(channel, index + 1);
    callbacks.get(channel)?.({ index, message });
  };

  // The page's connection to the relay.
  let conn: string | null = null;
  let resolveConn: (c: string) => void = () => {};
  let rejectConn: (reason: string) => void = () => {};
  const connReady = new Promise<string>((resolve, reject) => {
    resolveConn = resolve;
    rejectConn = reject;
  });
  connReady.catch(() => {});
  const wsUrl = new URL("ws", base);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new win.WebSocket(String(wsUrl));
  socket.onmessage = (event: { data: string }) => {
    let m: any;
    try {
      m = JSON.parse(event.data);
    } catch {
      return;
    }
    if (m?.type === "hello" && typeof m.conn === "string") {
      conn = m.conn;
      resolveConn(m.conn);
    } else if (m?.type === "lost") {
      toParent({ type: "lost", reason: String(m.reason ?? "") });
    } else if (typeof m?.channel === "number") {
      deliver(m.channel, m.message);
    }
  };
  socket.onclose = () => rejectConn("The GitWand connection closed");

  const relay = async (path: string, init?: { method: string; body: unknown }) => {
    const response = await win.fetch(new URL(path, base), init ? { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : undefined);
    let out: any;
    try {
      out = await response.json();
    } catch {
      throw `GitWand relay answered HTTP ${response.status}`;
    }
    if (out && "error" in out) throw out.error;
    if (!response.ok) throw `GitWand relay answered HTTP ${response.status}`;
    return out;
  };

  // Events emitted and listened to inside the page (the UI only listens to its own).
  const listeners = new Map<string, Map<number, number>>();
  let nextEventId = 1;
  const unregisterListener = (event: string, eventId: number) => listeners.get(event)?.delete(eventId);

  // Folder picks answered by the BB page.
  const picks = new Map<number, (path: string | null) => void>();
  let nextPick = 1;
  win.addEventListener("message", (event: { origin: string; data: any }) => {
    const d = event.data;
    if (event.origin !== parentOrigin || d?.source !== "gitwand-host" || d.type !== "pick-folder-result") return;
    picks.get(d.id)?.(typeof d.path === "string" ? d.path : null);
    picks.delete(d.id);
  });

  let nextRid = 1;
  const updates = new Map<number, string>();
  const IMAGES = "Images are not available in GitWand inside BB";
  const CLIP_IMAGES = "Clipboard images are not available in GitWand inside BB";
  const ONE_STEP = "GitWand inside BB installs updates with downloadAndInstall only";

  const plugin = async (name: string, a: any): Promise<unknown> => {
    switch (name) {
      case "clipboard-manager|read_text":
        return win.navigator.clipboard.readText();
      case "clipboard-manager|write_text":
        await win.navigator.clipboard.writeText(String(a.text ?? ""));
        return null;
      case "clipboard-manager|clear":
        await win.navigator.clipboard.writeText("");
        return null;
      case "clipboard-manager|read_image":
      case "clipboard-manager|write_image":
        return fail(CLIP_IMAGES);
      case "clipboard-manager|write_html":
        return fail("HTML clipboard is not available in GitWand inside BB");
      case "dialog|open": {
        if (a.options?.directory !== true) return fail("Only folders can be picked in GitWand inside BB");
        const id = nextPick++;
        const answer = new Promise<string | null>((resolve) => picks.set(id, resolve));
        toParent({ type: "pick-folder", id });
        return answer;
      }
      case "event|listen": {
        const eventId = nextEventId++;
        const forEvent = listeners.get(a.event) ?? new Map<number, number>();
        forEvent.set(eventId, a.handler);
        listeners.set(a.event, forEvent);
        return eventId;
      }
      case "event|unlisten":
        unregisterListener(a.event, a.eventId);
        return null;
      case "event|emit":
      case "event|emit_to":
        for (const [eventId, handler] of listeners.get(a.event) ?? []) callbacks.get(handler)?.({ event: a.event, id: eventId, payload: a.payload });
        return null;
      case "image|from_bytes":
      case "image|from_path":
      case "image|new":
      case "image|rgba":
      case "image|size":
        return fail(IMAGES);
      case "menu|new":
      case "menu|create_default": {
        const rid = nextRid++;
        return [rid, `gitwand-menu-${rid}`];
      }
      case "menu|items":
        return [];
      case "menu|text":
        return "";
      case "menu|is_enabled":
        return true;
      case "menu|is_checked":
        return false;
      case "menu|get":
      case "menu|append":
      case "menu|prepend":
      case "menu|insert":
      case "menu|remove":
      case "menu|remove_at":
      case "menu|popup":
      case "menu|set_accelerator":
      case "menu|set_as_app_menu":
      case "menu|set_as_help_menu_for_nsapp":
      case "menu|set_as_window_menu":
      case "menu|set_as_windows_menu_for_nsapp":
      case "menu|set_checked":
      case "menu|set_enabled":
      case "menu|set_icon":
      case "menu|set_text":
        return null;
      case "notification|is_permission_granted":
        return true;
      case "notification|request_permission":
        return "granted";
      case "notification|notify":
        toParent({ type: "notify", title: String(a.options?.title ?? ""), body: String(a.options?.body ?? "") });
        return null;
      case "process|restart":
        reload();
        return null;
      case "process|exit":
      case "resources|close":
        return null;
      case "updater|check": {
        const { update } = await relay("update");
        if (!update) return null;
        const rid = nextRid++;
        updates.set(rid, update.version);
        return { rid, currentVersion: update.currentVersion, version: update.version, date: update.date ?? undefined, body: update.body ?? undefined, rawJson: update };
      }
      case "updater|download":
      case "updater|install":
        return fail(ONE_STEP);
      case "updater|download_and_install": {
        const channel = typeof a.onEvent?.id === "number" ? a.onEvent.id : null;
        if (channel !== null) deliver(channel, { event: "Started", data: { contentLength: 0 } });
        await relay("update/install", { method: "POST", body: { version: updates.get(a.rid) ?? null } });
        if (channel !== null) deliver(channel, { event: "Finished" });
        return null;
      }
      default:
        return fail(`GitWand inside BB does not support plugin:${name}`);
    }
  };

  // Keystrokes to one terminal must arrive in order. Each invoke is its own
  // HTTP request and the bridge runs requests concurrently, so writes to the
  // same terminal wait for the previous one.
  const writeQueues = new Map<string, Promise<unknown>>();
  const invoke = (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (cmd !== "terminal_write") return send(cmd, args);
    const key = String(args?.id);
    const next = (writeQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => send(cmd, args));
    writeQueues.set(key, next);
    next.finally(() => {
      if (writeQueues.get(key) === next) writeQueues.delete(key);
    }).catch(() => undefined);
    return next;
  };

  const send = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (cmd.startsWith("plugin:")) return plugin(cmd.slice("plugin:".length), args ?? {});
    const json = JSON.stringify(args ?? {});
    if (json.includes('"__CHANNEL__:')) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        connReady,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject("The GitWand connection did not open"), 10_000);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    const body = conn === null ? { cmd, args: JSON.parse(json) } : { cmd, args: JSON.parse(json), conn };
    const out = await relay("invoke", { method: "POST", body });
    return out.ok;
  };

  win.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback: (id: number) => callbacks.delete(id),
    runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
    callbacks,
    convertFileSrc: (path: string) => path,
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: {},
  };
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener };
}
