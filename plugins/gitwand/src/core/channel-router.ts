// Channel ids come from each page's own callback counter, so two pages can
// both send "__CHANNEL__:1". The relay gives every page channel a bridge-wide
// id before the call reaches gitwand-bridge, and maps the bridge's channel
// messages back to the connection and the page's own id.

const CHANNEL = /^__CHANNEL__:(\d+)$/;

export interface ChannelRoute {
  conn: string;
  channel: number;
}

export class ChannelRouter {
  private next = 1;
  private readonly routes = new Map<number, ChannelRoute>();

  /** Whether any string inside `value` is a channel reference. */
  hasChannel(value: unknown): boolean {
    if (typeof value === "string") return CHANNEL.test(value);
    if (Array.isArray(value)) return value.some((v) => this.hasChannel(v));
    if (value !== null && typeof value === "object") return Object.values(value).some((v) => this.hasChannel(v));
    return false;
  }

  /** A copy of `args` with every page channel replaced by a bridge-wide one. */
  rewriteArgs(conn: string, args: Record<string, unknown>): Record<string, unknown> {
    return this.rewrite(conn, args) as Record<string, unknown>;
  }

  private rewrite(conn: string, value: unknown): unknown {
    if (typeof value === "string") {
      const m = CHANNEL.exec(value);
      if (m === null) return value;
      const id = this.next++;
      this.routes.set(id, { conn, channel: Number(m[1]) });
      return `__CHANNEL__:${id}`;
    }
    if (Array.isArray(value)) return value.map((v) => this.rewrite(conn, v));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.rewrite(conn, v)]));
    }
    return value;
  }

  route(bridgeChannel: number): ChannelRoute | null {
    return this.routes.get(bridgeChannel) ?? null;
  }

  dropConn(conn: string): void {
    for (const [id, route] of this.routes) if (route.conn === conn) this.routes.delete(id);
  }
}
