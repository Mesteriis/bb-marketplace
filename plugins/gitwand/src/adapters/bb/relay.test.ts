import { describe, expect, it } from "vitest";
import { GitwandRelay, type RelaySocket } from "./relay.ts";
import type { BridgeResult } from "./bridge-process.ts";

class FakeSocket implements RelaySocket {
  readyState = 1;
  sent: unknown[] = [];
  closed: [number | undefined, string | undefined] | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = [code, reason];
    this.readyState = 3;
  }
}

function setup(answer: (cmd: string, args: Record<string, unknown>) => BridgeResult = () => ({ ok: true, value: "done" })) {
  const calls: { cmd: string; args: Record<string, unknown>; conn?: string }[] = [];
  const bridge = {
    alive: true,
    call: async (cmd: string, args: Record<string, unknown>, conn?: string) => {
      calls.push(conn === undefined ? { cmd, args } : { cmd, args, conn });
      return answer(cmd, args);
    },
  };
  let n = 0;
  const relay = new GitwandRelay({ get: async () => bridge, current: () => bridge }, () => `conn-${++n}`);
  return { relay, calls };
}

describe("GitwandRelay WebSocket", () => {
  it("greets each socket with its own connection id", () => {
    const { relay } = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    expect(relay.open(a)).toBe("conn-1");
    expect(relay.open(b)).toBe("conn-2");
    expect(a.sent).toEqual([{ type: "hello", conn: "conn-1" }]);
    expect(b.sent).toEqual([{ type: "hello", conn: "conn-2" }]);
  });

  it("delivers a channel message only to the page that owns the channel, under the page's id", async () => {
    const { relay, calls } = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    relay.open(a);
    relay.open(b);
    await relay.invoke({ cmd: "terminal_open", args: { cwd: "/r", onOutput: "__CHANNEL__:3" }, conn: "conn-1" });
    await relay.invoke({ cmd: "terminal_open", args: { cwd: "/r", onOutput: "__CHANNEL__:3" }, conn: "conn-2" });
    expect(calls).toEqual([
      { cmd: "terminal_open", args: { cwd: "/r", onOutput: "__CHANNEL__:1" }, conn: "conn-1" },
      { cmd: "terminal_open", args: { cwd: "/r", onOutput: "__CHANNEL__:2" }, conn: "conn-2" },
    ]);
    relay.onBridgeChannel(2, { type: "chunk", data: "for b" });
    expect(a.sent.slice(1)).toEqual([]);
    expect(b.sent.slice(1)).toEqual([{ channel: 3, message: { type: "chunk", data: "for b" } }]);
  });

  it("drops messages for channels it never issued", () => {
    const { relay } = setup();
    const a = new FakeSocket();
    relay.open(a);
    relay.onBridgeChannel(42, "x");
    expect(a.sent).toEqual([{ type: "hello", conn: "conn-1" }]);
  });

  it("closes the connection's terminals and watchers in the bridge when its socket closes", async () => {
    const { relay, calls } = setup();
    const a = new FakeSocket();
    relay.open(a);
    await relay.invoke({ cmd: "watch_repo_start", args: { cwd: "/r", onChange: "__CHANNEL__:1" }, conn: "conn-1" });
    await relay.close("conn-1");
    expect(calls.at(-1)).toEqual({ cmd: "__close_conn", args: { conn: "conn-1" } });
    relay.onBridgeChannel(1, "late");
    expect(a.sent).toEqual([{ type: "hello", conn: "conn-1" }]);
  });

  it("tells every page when the bridge is lost and closes their sockets", () => {
    const { relay } = setup();
    const a = new FakeSocket();
    relay.open(a);
    relay.onBridgeLost("gitwand-bridge exited (code 1)");
    expect(a.sent.at(-1)).toEqual({ type: "lost", reason: "gitwand-bridge exited (code 1)" });
    expect(a.closed).toEqual([1011, "gitwand-bridge stopped"]);
  });
});

describe("GitwandRelay invoke", () => {
  it("runs a command without a connection and returns its value", async () => {
    const { relay, calls } = setup(() => ({ ok: true, value: { branch: "main" } }));
    expect(await relay.invoke({ cmd: "git_status", args: { cwd: "/r" } })).toEqual({ status: 200, body: { ok: { branch: "main" } } });
    expect(calls).toEqual([{ cmd: "git_status", args: { cwd: "/r" } }]);
  });

  it("returns the command's error as data with status 200", async () => {
    const { relay } = setup(() => ({ ok: false, error: "not a git repository" }));
    expect(await relay.invoke({ cmd: "git_status", args: { cwd: "/r" } })).toEqual({ status: 200, body: { error: "not a git repository" } });
  });

  it("forwards the page's connection with every call it names", async () => {
    const { relay, calls } = setup();
    relay.open(new FakeSocket());
    await relay.invoke({ cmd: "git_status", args: {}, conn: "conn-1" });
    expect(calls).toEqual([{ cmd: "git_status", args: {}, conn: "conn-1" }]);
  });

  it("refuses a channel argument without an open connection", async () => {
    const { relay, calls } = setup();
    expect(await relay.invoke({ cmd: "terminal_open", args: { onOutput: "__CHANNEL__:1" }, conn: "conn-9" })).toEqual({
      status: 409,
      body: { error: "This call streams over a GitWand connection, and none is open" },
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ["a service command", { cmd: "__close_conn", args: { conn: "conn-1" } }],
    ["a Tauri plugin command", { cmd: "plugin:dialog|open", args: {} }],
    ["no command", { args: {} }],
    ["args that are not an object", { cmd: "git_status", args: [1] }],
    ["an unknown connection", { cmd: "git_status", args: {}, conn: "conn-9" }],
  ])("refuses %s with 400", async (_name, body) => {
    const { relay, calls } = setup();
    const r = await relay.invoke(body);
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 503 with the reason when the bridge cannot start", async () => {
    const relay = new GitwandRelay({ get: async () => Promise.reject(new Error("The GitWand runtime is not installed")), current: () => null });
    expect(await relay.invoke({ cmd: "git_status", args: {} })).toEqual({ status: 503, body: { error: "The GitWand runtime is not installed" } });
  });
});

describe("GitwandRelay plugin commands", () => {
  function withLocal(handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>) {
    const calls: string[] = [];
    const bridge = { alive: true, call: async (cmd: string) => (calls.push(cmd), { ok: true as const, value: "bridge" }) };
    const relay = new GitwandRelay({ get: async () => bridge, current: () => bridge }, () => "conn-1", handlers);
    return { relay, calls };
  }

  it("answers a plugin command itself and never reaches the bridge", async () => {
    const { relay, calls } = withLocal({ repo_catalog: async (args) => ({ echoed: args }) });
    expect(await relay.invoke({ cmd: "repo_catalog", args: { a: 1 } })).toEqual({ status: 200, body: { ok: { echoed: { a: 1 } } } });
    expect(calls).toEqual([]);
  });

  it("returns a plugin command's failure as the command's error", async () => {
    const { relay } = withLocal({
      repo_catalog_refresh: async () => {
        throw new Error("Workspace file is not valid JSON");
      },
    });
    expect(await relay.invoke({ cmd: "repo_catalog_refresh", args: {} })).toEqual({ status: 200, body: { error: "Workspace file is not valid JSON" } });
  });

  it("still sends other commands to the bridge", async () => {
    const { relay, calls } = withLocal({ repo_catalog: async () => null });
    expect(await relay.invoke({ cmd: "git_status", args: {} })).toEqual({ status: 200, body: { ok: "bridge" } });
    expect(calls).toEqual(["git_status"]);
  });
});
