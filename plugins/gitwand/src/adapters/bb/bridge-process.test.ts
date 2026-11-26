import { describe, expect, it } from "vitest";
import { BridgeProcess, BridgeSupervisor, bridgeEnv, type SpawnBridge } from "./bridge-process.ts";
import { FakeChild } from "./testing/fake-child.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function spawner(children: FakeChild[], calls: { bin: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = []): SpawnBridge {
  return (bin, args, options) => {
    calls.push({ bin, args, env: options.env });
    const child = new FakeChild();
    children.push(child);
    return child as never;
  };
}

describe("BridgeProcess.start", () => {
  it("spawns the binary without arguments and greets it with __hello first", async () => {
    const children: FakeChild[] = [];
    const calls: { bin: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const bridge = await BridgeProcess.start({ bin: "/rt/bin/gitwand-bridge", env: { HOME: "/h" }, spawn: spawner(children, calls) });
    expect(calls).toEqual([{ bin: "/rt/bin/gitwand-bridge", args: [], env: { HOME: "/h" } }]);
    expect(children[0].requests[0]).toEqual({ id: 1, cmd: "__hello", args: {} });
    expect(bridge.hello).toMatchObject({ protocol: 1, runtime: "3.14.0+bb1", generated: 336 });
  });

  it("fails and kills the process when __hello is not answered in time", async () => {
    const children: FakeChild[] = [];
    const spawn: SpawnBridge = (...a) => {
      const c = spawner(children)(...a);
      children[0].onRequest = () => {};
      return c;
    };
    await expect(BridgeProcess.start({ bin: "b", env: {}, spawn, helloTimeoutMs: 20 })).rejects.toThrow("gitwand-bridge did not answer __hello within 20 ms");
    expect(children[0].signals).toEqual(["SIGKILL"]);
  });

  it("fails with the end of stderr when the process exits before answering", async () => {
    const children: FakeChild[] = [];
    const spawn: SpawnBridge = (...a) => {
      const c = spawner(children)(...a);
      children[0].onRequest = () => {
        children[0].stderr.write("dyld: Library not loaded\n");
        setTimeout(() => children[0].exit(134), 5);
      };
      return c;
    };
    await expect(BridgeProcess.start({ bin: "b", env: {}, spawn })).rejects.toThrow("gitwand-bridge exited (code 134) before answering __hello: dyld: Library not loaded");
  });

  it("refuses a bridge that speaks another protocol version", async () => {
    const children: FakeChild[] = [];
    const spawn: SpawnBridge = (...a) => {
      const c = spawner(children)(...a);
      children[0].onRequest = (req) => children[0].reply({ id: req.id, ok: { protocol: 2 } });
      return c;
    };
    await expect(BridgeProcess.start({ bin: "b", env: {}, spawn })).rejects.toThrow("gitwand-bridge speaks protocol 2, the plugin speaks 1");
  });
});

describe("BridgeProcess calls", () => {
  async function started() {
    const children: FakeChild[] = [];
    const bridge = await BridgeProcess.start({ bin: "b", env: {}, spawn: spawner(children) });
    return { bridge, child: children[0] };
  }

  it("sends cmd, args and conn, and matches answers to calls by id in any order", async () => {
    const { bridge, child } = await started();
    child.onRequest = () => {};
    const a = bridge.call("git_status", { cwd: "/a" }, "c1");
    const b = bridge.call("git_log", { cwd: "/b" });
    await tick();
    expect(child.requests.slice(1)).toEqual([
      { id: 2, cmd: "git_status", args: { cwd: "/a" }, conn: "c1" },
      { id: 3, cmd: "git_log", args: { cwd: "/b" } },
    ]);
    child.reply({ id: 3, error: "not a repo" });
    child.reply({ id: 2, ok: { branch: "main" } });
    expect(await a).toEqual({ ok: true, value: { branch: "main" } });
    expect(await b).toEqual({ ok: false, error: "not a repo" });
  });

  it("passes channel messages to listeners and ignores stray lines", async () => {
    const { bridge, child } = await started();
    const got: unknown[] = [];
    const stray: string[] = [];
    bridge.onChannel((channel, message) => got.push([channel, message]));
    bridge.onInvalidLine((line) => stray.push(line));
    child.writeRaw("thread 'main' panicked");
    child.reply({ channel: 4, message: { type: "chunk", data: "x" } });
    await tick();
    expect(got).toEqual([[4, { type: "chunk", data: "x" }]]);
    expect(stray).toEqual(["thread 'main' panicked"]);
  });

  it("rejects pending and later calls once the process has exited", async () => {
    const { bridge, child } = await started();
    child.onRequest = () => {};
    const pending = bridge.call("git_status", { cwd: "/a" });
    await tick();
    child.exit(1);
    await expect(pending).rejects.toThrow("gitwand-bridge exited (code 1)");
    await expect(bridge.call("git_status", {})).rejects.toThrow("gitwand-bridge exited (code 1)");
    expect(bridge.alive).toBe(false);
  });
});

describe("BridgeProcess.stop", () => {
  it("closes stdin and sends no signal when the process exits by itself", async () => {
    const children: FakeChild[] = [];
    const bridge = await BridgeProcess.start({ bin: "b", env: {}, spawn: spawner(children) });
    children[0].on("stdin-closed", () => children[0].exit(0));
    await bridge.stop(30);
    expect(children[0].stdinClosed).toBe(true);
    expect(children[0].signals).toEqual([]);
  });

  it("escalates to SIGTERM, then SIGKILL, when the process stays", async () => {
    const children: FakeChild[] = [];
    const bridge = await BridgeProcess.start({ bin: "b", env: {}, spawn: spawner(children) });
    await bridge.stop(10);
    expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("BridgeSupervisor", () => {
  const runtime = { bin: "/rt/bin/gitwand-bridge", env: { HOME: "/h" } };

  it("starts one bridge for concurrent callers", async () => {
    const children: FakeChild[] = [];
    const sup = new BridgeSupervisor({ resolve: async () => runtime, spawn: spawner(children) });
    const [a, b] = await Promise.all([sup.get(), sup.get()]);
    expect(a).toBe(b);
    expect(children.length).toBe(1);
    expect(sup.status()).toMatchObject({ state: "running", runtime: "3.14.0+bb1" });
  });

  it("reports a lost bridge and starts a new one on the next call", async () => {
    const children: FakeChild[] = [];
    const lost: number[] = [];
    const sup = new BridgeSupervisor({ resolve: async () => runtime, spawn: spawner(children) });
    sup.onLost(() => lost.push(1));
    await sup.get();
    children[0].exit(null, "SIGSEGV");
    expect(lost).toEqual([1]);
    expect(sup.status().state).toBe("stopped");
    await sup.get();
    expect(children.length).toBe(2);
  });

  it("stops restarting after three exits within the window, until restart()", async () => {
    const children: FakeChild[] = [];
    const sup = new BridgeSupervisor({ resolve: async () => runtime, spawn: spawner(children), crashWindowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await sup.get();
      children[i].exit(101);
    }
    await expect(sup.get()).rejects.toThrow("gitwand-bridge exited 3 times in a row; press Restart in the plugin settings");
    expect(sup.status()).toMatchObject({ state: "failed" });
    await sup.restart();
    expect(children.length).toBe(4);
    expect(sup.status().state).toBe("running");
  });

  it("says so when no runtime is installed", async () => {
    const sup = new BridgeSupervisor({ resolve: async () => null, spawn: spawner([]) });
    await expect(sup.get()).rejects.toThrow("The GitWand runtime is not installed");
    expect(sup.status()).toEqual({ state: "no-runtime" });
  });

  it("stops the bridge it runs and does not start another on its own", async () => {
    const children: FakeChild[] = [];
    const sup = new BridgeSupervisor({ resolve: async () => runtime, spawn: spawner(children) });
    await sup.get();
    children[0].on("stdin-closed", () => children[0].exit(0));
    await sup.stop();
    expect(children[0].stdinClosed).toBe(true);
    expect(sup.status().state).toBe("stopped");
    expect(children.length).toBe(1);
  });
});

describe("bridgeEnv", () => {
  it("keeps HOME and PATH from the host environment", () => {
    expect(bridgeEnv({ HOME: "/Users/u", PATH: "/usr/bin", SHELL: "/bin/zsh" }, "/bin/bash")).toEqual({ HOME: "/Users/u", PATH: "/usr/bin", SHELL: "/bin/zsh" });
  });

  it("adds the user's login shell when SHELL is missing", () => {
    expect(bridgeEnv({ HOME: "/Users/u", PATH: "/usr/bin" }, "/bin/zsh").SHELL).toBe("/bin/zsh");
  });

  it("drops Node and Electron switches that would change tools run in the terminal", () => {
    const env = bridgeEnv({ HOME: "/h", PATH: "/p", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production" }, "/bin/zsh");
    expect(env).toEqual({ HOME: "/h", PATH: "/p", SHELL: "/bin/zsh" });
  });

  it("refuses to start without HOME, which the Keychain needs", () => {
    expect(() => bridgeEnv({ PATH: "/p" }, "/bin/zsh")).toThrow("HOME is not set");
  });
});

describe("BridgeSupervisor.running", () => {
  it("returns the live bridge without starting one", async () => {
    const children: FakeChild[] = [];
    const sup = new BridgeSupervisor({ resolve: async () => ({ bin: "b", env: { HOME: "/h" } }), spawn: spawner(children) });
    expect(sup.running()).toBeNull();
    const bridge = await sup.get();
    expect(sup.running()).toBe(bridge);
    children[0].exit(1);
    expect(sup.running()).toBeNull();
    expect(children.length).toBe(1);
  });
});
