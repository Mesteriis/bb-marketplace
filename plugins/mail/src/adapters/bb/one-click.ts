// The RFC 8058 one-click unsubscribe POST (slice 3e), the plugin's only
// outbound HTTP request. Only the server's unsubscribe path calls it, after
// the owner's confirmed click or tick. The URL is the stored List-Unsubscribe
// https value, checked again here; the host is resolved once and every
// address must be public unicast (spec resolution 21), and the socket goes to
// that vetted address (no second lookup, so no rebinding). No proxy, no
// redirect, no cookie; the response's headers are never read and its body is
// drained up to 16 KiB and dropped. Outcomes and errors are fixed codes,
// never the URL, the host or anything the server sent.
import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Clock, PostOutcome, UnsubscribePoster } from "../../core/index.ts";
import { validHttps } from "../../core/index.ts";

export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";
/** DNS and the TLS handshake together. */
export const ONE_CLICK_CONNECT_MS = 5_000;
/** The whole request. */
export const ONE_CLICK_TOTAL_MS = 10_000;
/** Response bytes read (and dropped) at most. */
export const ONE_CLICK_DRAIN_BYTES = 16 * 1024;

export type ResolvedAddress = { address: string; family: number };

export interface OneClickOptions {
  /** Resolves a host to every address (dns.lookup with all: true by default). */
  lookup?: (host: string) => Promise<ResolvedAddress[]>;
  /** Extra trust anchors (tests only); Node's default CA store otherwise. */
  ca?: string | Buffer;
  clock: Clock;
  /** Tests only: the port to connect to (443 otherwise). */
  port?: number;
  /** Tests only: the address check (isAllowedAddress otherwise). */
  allowAddress?: (ip: string) => boolean;
}

// ---------------------------------------------------------------------------
// Address allow-list
// ---------------------------------------------------------------------------

function parseIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

/** IANA IPv4 Special-Purpose Address Registry blocks (and multicast, reserved, broadcast). */
const IPV4_REFUSED: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

const IPV4_BLOCKS = IPV4_REFUSED.map(([base, bits]) => {
  const size = 2 ** (32 - bits);
  const start = parseIpv4(base) as number;
  return { start, end: start + size - 1 };
});

function ipv4Allowed(value: number): boolean {
  return !IPV4_BLOCKS.some((block) => value >= block.start && value <= block.end);
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse (zone ids refused). */
function parseIpv6(text: string): number[] | null {
  if (text.includes("%")) return null;
  let head = text;
  const tail: number[] = [];
  const lastColon = head.lastIndexOf(":");
  if (head.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(head.slice(lastColon + 1));
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 65_536), v4 % 65_536);
    head = head.slice(0, lastColon + 1);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = toGroups(halves[0] as string);
  const right = halves.length === 2 ? toGroups(halves[1] as string) : [];
  if (left === null || right === null) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...left, ...new Array<number>(8 - known).fill(0), ...right, ...tail];
  }
  return known === 8 ? [...left, ...tail] : null;
}

/**
 * Whether a resolved address may be connected to: public unicast only (spec
 * resolution 21). IPv4 outside every special-purpose block; IPv6 inside
 * 2000::/3 minus 2001::/23 (Teredo included), 2001:db8::/32, 2002::/16 and
 * 3fff::/20; NAT64 prefixes fall outside 2000::/3. IPv4-mapped and
 * -compatible forms are judged by their IPv4 address.
 */
export function isAllowedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const value = parseIpv4(ip);
    return value !== null && ipv4Allowed(value);
  }
  if (kind !== 6) return false;
  const groups = parseIpv6(ip);
  if (groups === null) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const embedded = g6 * 65_536 + g7;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return ipv4Allowed(embedded);
  }
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false;
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  if (g0 === 0x2002) return false;
  if (g0 === 0x3fff && g1 < 0x1000) return false;
  return true;
}

/**
 * A `lookup` for the request that answers with the vetted address only,
 * whatever it is asked: `(err, address, family)` and, with `all: true` (as
 * Node 24's net passes for autoSelectFamily), `(err, addresses[])`.
 */
export function pinnedLookup(vetted: ResolvedAddress): LookupFunction {
  return ((_host: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: unknown }).all === true;
    process.nextTick(() => {
      if (all) cb(null, [{ address: vetted.address, family: vetted.family }]);
      else cb(null, vetted.address, vetted.family);
    });
  }) as LookupFunction;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

class AddressRefused extends Error {}

const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|ERR_OSSL_)/;

function failureOf(error: unknown): PostOutcome {
  if (error instanceof AddressRefused) return { kind: "failed", reason: "address" };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TLS_CODE.test(code)) return { kind: "failed", reason: "tls" };
  return { kind: "failed", reason: "network" };
}

function outcomeOf(status: number): PostOutcome {
  if (status >= 200 && status < 300) return { kind: "done" };
  if (status >= 300 && status < 400) return { kind: "redirected" };
  if (status >= 500) return { kind: "failed", reason: "server" };
  return { kind: "failed", reason: "client" };
}

const defaultLookup = async (host: string): Promise<ResolvedAddress[]> =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));

export function createOneClickPoster(options: OneClickOptions): UnsubscribePoster {
  const resolve = options.lookup ?? defaultLookup;
  const allow = options.allowAddress ?? isAllowedAddress;
  const port = options.port ?? 443;

  return {
    post(rawUrl, signal) {
      return new Promise<PostOutcome>((settle) => {
        let done = false;
        const timers: ReturnType<typeof setTimeout>[] = [];
        let cancel: () => void = () => {};
        const finish = (outcome: PostOutcome) => {
          if (done) return;
          done = true;
          for (const timer of timers) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          settle(outcome);
        };
        const onAbort = () => {
          cancel();
          finish({ kind: "failed", reason: "network" });
        };
        if (signal.aborted) return finish({ kind: "failed", reason: "network" });
        signal.addEventListener("abort", onAbort, { once: true });

        const href = validHttps(rawUrl);
        if (href === null) return finish({ kind: "failed", reason: "client" });
        const url = new URL(href);
        const host = url.hostname;

        let connected = false;
        timers.push(
          setTimeout(() => {
            if (connected) return;
            cancel();
            finish({ kind: "failed", reason: "timeout" });
          }, ONE_CLICK_CONNECT_MS),
          setTimeout(() => {
            cancel();
            finish({ kind: "failed", reason: "timeout" });
          }, ONE_CLICK_TOTAL_MS),
        );

        resolve(host)
          .then((addresses) => {
            if (done) return;
            if (addresses.length === 0 || !addresses.every((entry) => allow(entry.address))) {
              throw new AddressRefused();
            }
            const vetted = addresses[0] as ResolvedAddress;
            const body = Buffer.from(ONE_CLICK_BODY);
            const req = request({
              method: "POST",
              protocol: "https:",
              host,
              servername: host,
              port,
              path: `${url.pathname}${url.search}`,
              // A fresh socket per request: no keep-alive, no global agent, so
              // no proxy from the environment and no pooled connection.
              agent: false,
              lookup: pinnedLookup(vetted),
              minVersion: "TLSv1.2",
              ...(options.ca !== undefined ? { ca: options.ca } : {}),
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": String(body.byteLength),
                "User-Agent": "Makosh-Mail",
                Accept: "*/*",
              },
            });
            cancel = () => req.destroy();
            req.on("socket", (socket) => {
              socket.once("secureConnect", () => {
                connected = true;
              });
            });
            req.on("error", (error) => finish(failureOf(error)));
            req.on("response", (response) => {
              // Status only: no header is read. The body is drained and dropped.
              let read = 0;
              response.on("data", (chunk: Buffer) => {
                read += chunk.byteLength;
                if (read > ONE_CLICK_DRAIN_BYTES) response.destroy();
              });
              response.on("error", () => {});
              finish(outcomeOf(response.statusCode ?? 0));
            });
            req.end(body);
          })
          .catch((error: unknown) => finish(failureOf(error)));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

export const UNSUBSCRIBE_PER_MESSAGE_MS = 10 * 60_000;
export const UNSUBSCRIBE_PER_HOUR = 30;
const HOUR_MS = 3_600_000;

/**
 * One-click requests at most once per message per 10 minutes and 30 per
 * hour in total (memory only), so a looping caller cannot turn the plugin
 * into a request generator.
 */
export class UnsubscribeRate {
  private readonly byMessage = new Map<string, number>();
  private recent: number[] = [];

  constructor(private readonly clock: Clock) {}

  private prune(now: number): void {
    this.recent = this.recent.filter((at) => now - at < HOUR_MS);
    for (const [id, at] of this.byMessage) {
      if (now - at >= UNSUBSCRIBE_PER_MESSAGE_MS) this.byMessage.delete(id);
    }
  }

  /** Requests left this hour. */
  remaining(): number {
    this.prune(this.clock.now().getTime());
    return Math.max(0, UNSUBSCRIBE_PER_HOUR - this.recent.length);
  }

  /** Whether a request for this message may go now (nothing is recorded). */
  allows(messageId: string): boolean {
    this.prune(this.clock.now().getTime());
    return !this.byMessage.has(messageId) && this.recent.length < UNSUBSCRIBE_PER_HOUR;
  }

  /** Records a request for this message when allowed; false when rate-limited. */
  take(messageId: string): boolean {
    if (!this.allows(messageId)) return false;
    const now = this.clock.now().getTime();
    this.byMessage.set(messageId, now);
    this.recent.push(now);
    return true;
  }
}
