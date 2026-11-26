// The relay between GitWand pages and gitwand-bridge. A page invokes
// commands with POST /gw/invoke and receives its channel messages over its
// own WebSocket (/gw/ws). Each socket is a connection: its channels get
// bridge-wide ids (ChannelRouter), and its terminals and watchers are closed
// in the bridge when the socket closes.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChannelRouter } from "../../core/channel-router.ts";
import type { BridgeResult } from "./bridge-process.ts";

export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

interface RelayBridge {
  readonly alive: boolean;
  call(cmd: string, args: Record<string, unknown>, conn?: string): Promise<BridgeResult>;
}

export interface RelayBridgeSource {
  /** Starts the bridge if needed. */
  get(): Promise<RelayBridge>;
  /** The running bridge, without starting one. */
  current(): RelayBridge | null;
}

const invokeBody = z.object({
  // Page commands only: the bridge's service commands start with "__".
  cmd: z.string().regex(/^[a-z][a-z0-9_]*$/),
  args: z.record(z.string(), z.unknown()),
  conn: z.string().min(1).max(100).optional(),
});

export interface RelayResponse {
  status: number;
  body: { ok: unknown } | { error: unknown };
}

const OPEN = 1;

export class GitwandRelay {
  private readonly router = new ChannelRouter();
  private readonly sockets = new Map<string, RelaySocket>();

  constructor(
    private readonly bridges: RelayBridgeSource,
    private readonly newConnId: () => string = randomUUID,
  ) {}

  /** Registers a page socket; returns its connection id, also sent to the page. */
  open(socket: RelaySocket): string {
    const conn = this.newConnId();
    this.sockets.set(conn, socket);
    socket.send(JSON.stringify({ type: "hello", conn }));
    return conn;
  }

  async close(conn: string): Promise<void> {
    if (!this.sockets.delete(conn)) return;
    this.router.dropConn(conn);
    const bridge = this.bridges.current();
    if (bridge?.alive) await bridge.call("__close_conn", { conn }).catch(() => undefined);
  }

  onBridgeChannel(channel: number, message: unknown): void {
    const route = this.router.route(channel);
    if (route === null) return;
    const socket = this.sockets.get(route.conn);
    if (socket?.readyState === OPEN) socket.send(JSON.stringify({ channel: route.channel, message }));
  }

  /** The bridge died: every connection's terminals and watchers are gone with it. */
  onBridgeLost(reason: string): void {
    for (const [conn, socket] of this.sockets) {
      this.router.dropConn(conn);
      if (socket.readyState === OPEN) {
        socket.send(JSON.stringify({ type: "lost", reason }));
        socket.close(1011, "gitwand-bridge stopped");
      }
    }
    this.sockets.clear();
  }

  async invoke(body: unknown): Promise<RelayResponse> {
    const parsed = invokeBody.safeParse(body);
    if (!parsed.success) return { status: 400, body: { error: "Malformed GitWand call" } };
    const { cmd, conn } = parsed.data;
    let args = parsed.data.args;
    if (conn !== undefined && !this.sockets.has(conn)) {
      if (this.router.hasChannel(args)) return { status: 409, body: { error: "This call streams over a GitWand connection, and none is open" } };
      return { status: 400, body: { error: "Unknown GitWand connection" } };
    }
    if (this.router.hasChannel(args)) {
      if (conn === undefined) return { status: 409, body: { error: "This call streams over a GitWand connection, and none is open" } };
      args = this.router.rewriteArgs(conn, args);
    }
    let bridge: RelayBridge;
    try {
      bridge = await this.bridges.get();
    } catch (error) {
      return { status: 503, body: { error: (error as Error).message } };
    }
    try {
      const r = await bridge.call(cmd, args, conn);
      return { status: 200, body: r.ok ? { ok: r.value ?? null } : { error: r.error } };
    } catch (error) {
      return { status: 503, body: { error: (error as Error).message } };
    }
  }
}
