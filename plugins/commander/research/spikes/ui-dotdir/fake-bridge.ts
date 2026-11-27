// In-memory Bridge for the stage 0 spike. Only listing, stat, read and mkdir
// do anything; everything that needs a host refuses with an explicit error.
import type { Bridge, FsEntry } from "@dotdirfm/ui";

type Node = { kind: "dir"; children: Map<string, Node> } | { kind: "file"; data: Uint8Array; mtimeMs: number };

const enc = new TextEncoder();
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);
const file = (text: string): Node => ({ kind: "file", data: enc.encode(text), mtimeMs: T0 });
const dir = (entries: Record<string, Node>): Node => ({ kind: "dir", children: new Map(Object.entries(entries)) });

function makeTree(): Node {
  const many: Record<string, Node> = {};
  for (let i = 0; i < 2000; i++) many[`file-${String(i).padStart(4, "0")}.txt`] = file(`row ${i}\n`);
  return dir({
    home: dir({
      spike: dir({
        // DotDir reads its own settings at boot and does not handle ENOENT.
        ".config": dir({ "settings.json": file("{}") }),
        ".data": dir({ "extensionSettings.json": file("{}"), extensions: dir({ "extensions.json": file("[]") }) }),
        "readme.txt": file("DotDir in BB navPanel, stage 0 spike.\n"),
        "Привет мир.md": file("# Кириллица\n"),
        "😀 emoji.bin": file("x"),
        docs: dir({ "a.txt": file("a\n"), "b.txt": file("b\n") }),
        "2000-files": dir(many),
      }),
    }),
  });
}

const refuse = (what: string) => () => Promise.reject(new Error(`spike: ${what} is not implemented`));
const noop = () => () => {};

export function createFakeBridge(): Bridge {
  const root = makeTree();
  const fds = new Map<number, Uint8Array>();
  let nextFd = 1;
  const walk = (p: string): Node | undefined => {
    let n: Node | undefined = root;
    for (const part of p.split("/").filter(Boolean)) {
      if (!n || n.kind !== "dir") return undefined;
      n = n.children.get(part);
    }
    return n;
  };
  const need = (p: string): Node => {
    const n = walk(p);
    if (!n) throw new Error(`ENOENT: ${p}`);
    return n;
  };
  // mkdir -p for the parent, then replace the file: DotDir keeps its own
  // settings and layout under getAppDirs(), so the spike keeps them in memory.
  const put = (p: string, data: Uint8Array) => {
    const parts = p.split("/").filter(Boolean); const name = parts.pop()!;
    let n: Node = root;
    for (const part of parts) {
      if (n.kind !== "dir") throw new Error(`ENOTDIR: ${p}`);
      let c = n.children.get(part); if (!c) { c = dir({}); n.children.set(part, c); } n = c;
    }
    if (n.kind !== "dir") throw new Error(`ENOTDIR: ${p}`);
    n.children.set(name, { kind: "file", data, mtimeMs: Date.now() });
  };
  const toEntry = (name: string, n: Node): FsEntry => ({
    name,
    kind: n.kind === "dir" ? "directory" : "file",
    size: n.kind === "file" ? n.data.byteLength : 0,
    mtimeMs: n.kind === "file" ? n.mtimeMs : T0,
    mode: n.kind === "dir" ? 0o40755 : 0o100644,
    nlink: 1,
    hidden: name.startsWith("."),
  } as FsEntry);

  return {
    fs: {
      async entries(p) { const n = need(p); if (n.kind !== "dir") throw new Error(`ENOTDIR: ${p}`); return [...n.children].map(([k, v]) => toEntry(k, v)); },
      async stat(p) { const n = need(p); return { size: n.kind === "file" ? n.data.byteLength : 0, mtimeMs: T0 }; },
      async exists(p) { return walk(p) !== undefined; },
      async readFile(p) { const n = need(p); if (n.kind !== "file") throw new Error(`EISDIR: ${p}`); return n.data.slice().buffer; },
      async open(p) { const n = need(p); if (n.kind !== "file") throw new Error(`EISDIR: ${p}`); const fd = nextFd++; fds.set(fd, n.data); return fd; },
      async read(fd, off, len) { const d = fds.get(fd); if (!d) throw new Error("EBADF"); return d.slice(off, off + len).buffer; },
      async close(fd) { fds.delete(fd); },
      async watch() { return false; },
      async unwatch() {},
      onFsChange: noop,
      async writeFile(p, data) { put(p, enc.encode(data)); },
      async writeBinaryFile(p, data) { put(p, data.slice()); },
      async createDir(p) {
        const parts = p.split("/").filter(Boolean); const name = parts.pop()!;
        const parent = need("/" + parts.join("/")); if (parent.kind !== "dir") throw new Error("ENOTDIR");
        parent.children.set(name, dir({}));
      },
      moveToTrash: refuse("moveToTrash"),
      copy: { start: refuse("copy"), cancel: async () => {}, resolveConflict: async () => {}, onProgress: noop },
      move: { start: refuse("move"), cancel: async () => {}, resolveConflict: async () => {}, onProgress: noop },
      delete: { start: refuse("delete"), cancel: async () => {}, onProgress: noop },
      search: { start: refuse("search"), cancel: async () => {}, onProgress: noop },
      rename: { rename: refuse("rename") },
    },
    pty: { spawn: refuse("pty"), write: async () => {}, resize: async () => {}, close: async () => {}, onData: noop, onExit: noop },
    utils: {
      async getHomePath() { return "/home/spike"; },
      async getMountedRoots() { return ["/"]; },
      async getAppDirs() { return { homeDir: "/home/spike", configDir: "/home/spike/.config", dataDir: "/home/spike/.data", cacheDir: "/home/spike/.cache" }; },
      async getEnv() { return {}; },
    },
    systemTheme: { async get() { return "dark"; }, onChange: noop },
    extensions: { install: { start: refuse("extensions.install"), onProgress: noop } },
  };
}
