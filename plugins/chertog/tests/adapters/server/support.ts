// Fakes of the host for the server adapter tests: the plugin's key-value
// storage, its logger, and its HTTP, RPC and settings registries.
import { Hono } from "hono";
import type { BbPluginApi, PluginHttpHandler, PluginKvStorage, PluginLogger, PluginSettingDescriptor } from "@get-bb/plugin-sdk";

/** Lets every other pending task run, the way a real storage call gives up the thread. */
function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The plugin's key-value storage: JSON rows that survive the adapter. Every
 * call takes a turn of the event loop, so two saves that are not serialized
 * interleave here exactly as they would over the real storage.
 */
export class FakeKv implements PluginKvStorage {
  readonly rows = new Map<string, string>();
  /** Every call in order, as `get key`, `set key`, `delete key`, `list prefix`. */
  readonly calls: string[] = [];
  /** A key whose next write fails once. */
  failNextSetOf: string | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    this.calls.push("get " + key);
    await turn();
    const json = this.rows.get(key);
    return json === undefined ? undefined : (JSON.parse(json) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.calls.push("set " + key);
    await turn();
    if (this.failNextSetOf === key) {
      this.failNextSetOf = null;
      throw new Error("the storage is full");
    }
    this.rows.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.calls.push("delete " + key);
    await turn();
    this.rows.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    this.calls.push("list " + prefix);
    await turn();
    return [...this.rows.keys()].filter((key) => key.startsWith(prefix));
  }

  /** The stored keys, sorted. */
  keys(): string[] {
    return [...this.rows.keys()].sort();
  }

  /** The stored value of a key as JSON data, `undefined` for none. */
  value(key: string): unknown {
    const json = this.rows.get(key);
    return json === undefined ? undefined : JSON.parse(json);
  }

  /** Stores a value the way an earlier run of the plugin left it. */
  seed(key: string, value: unknown): void {
    this.rows.set(key, JSON.stringify(value));
  }
}

/** A logger that keeps every line with its level. */
export class FakeLog implements PluginLogger {
  readonly lines: string[] = [];
  debug(message: string): void {
    this.lines.push("debug " + message);
  }
  info(message: string): void {
    this.lines.push("info " + message);
  }
  warn(message: string): void {
    this.lines.push("warn " + message);
  }
  error(message: string): void {
    this.lines.push("error " + message);
  }
}

/** A clock that answers the given instants in order and then repeats the last one. */
export function clockOf(...instants: string[]): () => Date {
  let index = 0;
  return () => new Date(instants[Math.min(index++, instants.length - 1)]);
}

export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
  readonly auth: string | undefined;
}

/**
 * The plugin's HTTP registry. The routes are mounted on a real Hono app with
 * exact-path matching, as BB mounts them, so a test sends real requests.
 */
export class FakeHttp {
  readonly routes: RegisteredRoute[] = [];
  private readonly app = new Hono({ strict: true });

  route(method: string, path: string, handler: PluginHttpHandler, opts?: { auth?: "local" | "none" | "token" }): void {
    this.routes.push({ method, path, auth: opts?.auth });
    this.app.on(method, path, handler);
  }

  experimental_websocket(): void {
    throw new Error("the plugin registers no websocket");
  }

  /** Sends a request for a path inside the plugin's HTTP namespace. */
  async request(path: string, method = "GET"): Promise<Response> {
    return this.app.request("http://127.0.0.1:38886" + path, { method });
  }
}

/** The plugin's RPC registry: the contracts and handlers it was given. */
export class FakeRpc {
  readonly registered: { contract: Record<string, unknown>; handlers: Record<string, (input: unknown, context: unknown) => unknown> }[] = [];

  register(contract: Record<string, unknown>, handlers: Record<string, (input: unknown, context: unknown) => unknown>): void {
    this.registered.push({ contract, handlers });
  }
}

/**
 * The plugin's settings registry: every set of descriptors it was given, as
 * given, and a handle that reads their defaults, holds written values and
 * reports a write to the listeners, as BB does.
 */
export class FakeSettings {
  readonly defined: Record<string, PluginSettingDescriptor>[] = [];
  private values: Record<string, unknown> = {};
  private readonly listeners: ((next: Record<string, unknown>, prev: Record<string, unknown>) => void)[] = [];

  define(descriptors: Record<string, PluginSettingDescriptor>): unknown {
    this.defined.push(descriptors);
    const effective = () => {
      const defaults = Object.fromEntries(
        Object.entries(descriptors).flatMap(([key, descriptor]) => ("default" in descriptor ? [[key, descriptor.default]] : [])),
      );
      return { ...defaults, ...this.values };
    };
    return {
      get: async () => effective(),
      experimental_set: async () => {
        throw new Error("the server writes settings");
      },
      onChange: (listener: (next: Record<string, unknown>, prev: Record<string, unknown>) => void) => void this.listeners.push(listener),
      effective,
    };
  }

  /** A settings write as BB reports it. */
  write(patch: Record<string, unknown>): void {
    const [descriptors] = this.defined;
    const read = () => ({
      ...Object.fromEntries(Object.entries(descriptors).flatMap(([key, d]) => ("default" in d ? [[key, d.default]] : []))),
      ...this.values,
    });
    const prev = read();
    this.values = { ...this.values, ...patch };
    const next = read();
    for (const listener of this.listeners) listener(next, prev);
  }
}

/** The plugin inventory and the enable and disable calls of `bb.sdk.plugins`. */
export class FakePlugins {
  readonly calls: string[] = [];
  readonly inventory: { id: string; enabled: boolean }[] = [
    { id: "makosh-navigation", enabled: true },
    { id: "makosh-sidebar", enabled: true },
  ];
  async list() {
    return { plugins: this.inventory.map((plugin) => ({ ...plugin })) };
  }
  async enable({ pluginId }: { pluginId: string }) {
    this.calls.push("enable " + pluginId);
    const entry = this.inventory.find((plugin) => plugin.id === pluginId);
    if (entry) entry.enabled = true;
    return entry;
  }
  async disable({ pluginId }: { pluginId: string }) {
    this.calls.push("disable " + pluginId);
    const entry = this.inventory.find((plugin) => plugin.id === pluginId);
    if (entry) entry.enabled = false;
    return entry;
  }
}

export interface FakeHost {
  readonly bb: BbPluginApi;
  readonly kv: FakeKv;
  readonly log: FakeLog;
  readonly http: FakeHttp;
  readonly rpc: FakeRpc;
  readonly settings: FakeSettings;
  readonly plugins: FakePlugins;
}

/**
 * The part of the host the Chertog server uses. Reading anything else throws,
 * so a new dependency on the host shows up as a failing test.
 */
export function fakeHost(kv: FakeKv = new FakeKv()): FakeHost {
  const log = new FakeLog();
  const http = new FakeHttp();
  const rpc = new FakeRpc();
  const settings = new FakeSettings();
  const plugins = new FakePlugins();
  const used: Record<string, unknown> = { pluginId: "chertog", log, http, rpc, settings, storage: { kv }, sdk: { plugins } };
  const bb = new Proxy(used, {
    get(target, name) {
      if (typeof name === "string" && !Object.hasOwn(target, name)) throw new Error("the server reads bb." + name);
      return Reflect.get(target, name);
    },
  }) as unknown as BbPluginApi;
  return { bb, kv, log, http, rpc, settings, plugins };
}
