import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  ONE_CLICK_BODY,
  UNSUBSCRIBE_PER_HOUR,
  UNSUBSCRIBE_PER_MESSAGE_MS,
  UnsubscribeRate,
  createOneClickPoster,
  isAllowedAddress,
  pinnedLookup,
  type ResolvedAddress,
} from "./one-click.ts";

// A self-signed certificate for unsubscribe.example.invalid (a name that
// never resolves), made per run with the openssl CLI so no key is committed:
// a request that reaches the local server proves the socket went to the
// pinned address, not to a second lookup.
const certDir = mkdtempSync(join(tmpdir(), "one-click-test-"));
execFileSync(
  "openssl",
  [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", join(certDir, "test.key"), "-out", join(certDir, "test.crt"), "-days", "2",
    "-subj", "/CN=unsubscribe.example.invalid",
    "-addext", "subjectAltName=DNS:unsubscribe.example.invalid",
    "-addext", "basicConstraints=critical,CA:TRUE",
  ],
  { stdio: "ignore" },
);
const CERT = readFileSync(join(certDir, "test.crt"));
const KEY = readFileSync(join(certDir, "test.key"));
afterAll(() => rmSync(certDir, { recursive: true, force: true }));
const URL_TEXT = "https://unsubscribe.example.invalid/u/abc?list=1";
const clock = { now: () => new Date() };

type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };

const servers: { close: () => void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) server.close();
});

async function serve(handler: (seen: Seen, res: import("node:http").ServerResponse) => void) {
  const seen: Seen[] = [];
  const server: Server = createHttpsServer({ key: KEY, cert: CERT }, (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => server.closeAllConnections?.() ?? server.close() });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const lookups: string[] = [];
  const poster = createOneClickPoster({
    clock,
    ca: CERT,
    port,
    allowAddress: () => true,
    lookup: async (host) => {
      lookups.push(host);
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  return { seen, poster, lookups, port };
}

const signal = () => new AbortController().signal;

describe("createOneClickPoster", () => {
  it("POSTs exactly the one-click body with the fixed headers to the pinned address", async () => {
    const { seen, poster, lookups } = await serve((_seen, res) => res.end("ok"));
    expect(await poster.post(URL_TEXT, signal())).toEqual({ kind: "done" });
    expect(lookups).toEqual(["unsubscribe.example.invalid"]);
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/u/abc?list=1");
    expect(request?.body).toBe(ONE_CLICK_BODY);
    expect(Object.keys(request?.headers ?? {}).sort()).toEqual(
      ["accept", "connection", "content-length", "content-type", "host", "user-agent"].sort(),
    );
    expect(request?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(request?.headers["content-length"]).toBe(String(ONE_CLICK_BODY.length));
    expect(request?.headers["user-agent"]).toBe("Makosh-Mail");
    expect(request?.headers.accept).toBe("*/*");
    expect(request?.headers.connection).toBe("close");
  });

  it("sends no cookie after a Set-Cookie", async () => {
    const { seen, poster } = await serve((_seen, res) => {
      res.setHeader("Set-Cookie", "session=invented; Path=/");
      res.end();
    });
    await poster.post(URL_TEXT, signal());
    await poster.post(URL_TEXT, signal());
    expect(seen).toHaveLength(2);
    expect(seen[1]?.headers.cookie).toBeUndefined();
  });

  it("does not follow a redirect", async () => {
    const { seen, poster } = await serve((_seen, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "https://unsubscribe.example.invalid/elsewhere");
      res.end();
    });
    expect(await poster.post(URL_TEXT, signal())).toEqual({ kind: "redirected" });
    expect(seen).toHaveLength(1);
  });

  it("maps 4xx and 5xx to failed client / server", async () => {
    let status = 500;
    const { poster } = await serve((_seen, res) => {
      res.statusCode = status;
      res.end();
    });
    expect(await poster.post(URL_TEXT, signal())).toEqual({ kind: "failed", reason: "server" });
    status = 404;
    expect(await poster.post(URL_TEXT, signal())).toEqual({ kind: "failed", reason: "client" });
  });

  it("drains a large body and drops it", async () => {
    const { poster } = await serve((_seen, res) => {
      res.write(Buffer.alloc(512 * 1024, 120));
      res.end(Buffer.alloc(512 * 1024, 121));
    });
    expect(await poster.post(URL_TEXT, signal())).toEqual({ kind: "done" });
  });

  it("ignores proxy environment variables", async () => {
    const saved = { https: process.env.HTTPS_PROXY, lower: process.env.https_proxy };
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.https_proxy = "http://127.0.0.1:9";
    try {
      const { seen, poster } = await serve((_seen, res) => res.end());
      expect(await poster.post(URL_TEXT, signal())).toEqual({ kind: "done" });
      expect(seen).toHaveLength(1);
    } finally {
      if (saved.https === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved.https;
      if (saved.lower === undefined) delete process.env.https_proxy;
      else process.env.https_proxy = saved.lower;
    }
  });

  it("an untrusted certificate is failed tls", async () => {
    const { port } = await serve((_seen, res) => res.end());
    const poster = createOneClickPoster({
      clock,
      port,
      allowAddress: () => true,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(await poster.post(URL_TEXT, signal())).toEqual({ kind: "failed", reason: "tls" });
  });

  it("refuses when any resolved address is not public, before connecting", async () => {
    const lookup = async (): Promise<ResolvedAddress[]> => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    const poster = createOneClickPoster({ clock, lookup });
    expect(await poster.post(URL_TEXT, signal())).toEqual({ kind: "failed", reason: "address" });
    const loopback = createOneClickPoster({ clock, lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    expect(await loopback.post(URL_TEXT, signal())).toEqual({ kind: "failed", reason: "address" });
  });

  it("re-validates the URL and never resolves a refused one", async () => {
    const lookup = vi.fn(async (): Promise<ResolvedAddress[]> => [{ address: "8.8.8.8", family: 4 }]);
    const poster = createOneClickPoster({ clock, lookup });
    for (const url of [
      "http://unsubscribe.example.invalid/u",
      "https://203.0.113.5/u",
      "https://unsubscribe.example.invalid:8443/u",
      "https://user:pw@unsubscribe.example.invalid/u",
    ]) {
      expect(await poster.post(url, signal())).toEqual({ kind: "failed", reason: "client" });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("times out a server that never answers (10 s) and one that never completes TLS (5 s)", async () => {
    const { seen, poster } = await serve(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = poster.post(URL_TEXT, signal());
    while (seen.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ kind: "failed", reason: "timeout" });
    vi.useRealTimers();

    const silent = createNetServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    servers.push(silent);
    let accepted = 0;
    silent.on("connection", (socket) => {
      accepted++;
      servers.push({ close: () => socket.destroy() });
    });
    const stuck = createOneClickPoster({
      clock,
      ca: CERT,
      port: (silent.address() as AddressInfo).port,
      allowAddress: () => true,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const handshake = stuck.post(URL_TEXT, signal());
    while (accepted === 0) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await handshake).toEqual({ kind: "failed", reason: "timeout" });
  });

  it("an aborted signal ends the request", async () => {
    const { seen, poster } = await serve(() => {});
    const controller = new AbortController();
    const pending = poster.post(URL_TEXT, controller.signal);
    while (seen.length === 0) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await pending).toEqual({ kind: "failed", reason: "network" });
  });
});

describe("pinnedLookup", () => {
  it("answers both callback shapes with the vetted address only", async () => {
    const lookup = pinnedLookup({ address: "198.51.99.7", family: 4 });
    const single = await new Promise<unknown[]>((resolve) =>
      lookup("other.example.invalid", { family: 0 }, (...args: unknown[]) => resolve(args)),
    );
    expect(single).toEqual([null, "198.51.99.7", 4]);
    const all = await new Promise<unknown[]>((resolve) =>
      lookup("other.example.invalid", { all: true }, (...args: unknown[]) => resolve(args)),
    );
    expect(all).toEqual([null, [{ address: "198.51.99.7", family: 4 }]]);
  });
});

describe("isAllowedAddress", () => {
  it("refuses special-purpose IPv4 and IPv6 outside the public allow-list, mapped forms by their IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "0.0.0.0",
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "192.0.0.8",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.9",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "ff02::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "::10.0.0.1",
      "64:ff9b::a00:1",
      "64:ff9b:1::1",
      "2002:a00:1::",
      "2001:0::",
      "2001:0:4136:e378::1",
      "2001:db8::1",
      "3fff::1",
      "fe80::1%en0",
      "not-an-ip",
    ]) {
      expect(isAllowedAddress(ip), ip).toBe(false);
    }
  });

  it("allows public IPv4, 2000::/3 IPv6 and a mapped public IPv4", () => {
    for (const ip of ["8.8.8.8", "93.184.215.14", "2606:4700::1111", "2a00:1450:4001::1", "::ffff:8.8.8.8", "2001:200::1"]) {
      expect(isAllowedAddress(ip), ip).toBe(true);
    }
  });
});

describe("UnsubscribeRate", () => {
  it("allows one request per message per 10 minutes and 30 per hour", () => {
    let now = Date.parse("2026-11-16T10:00:00.000Z");
    const rate = new UnsubscribeRate({ now: () => new Date(now) });
    expect(rate.take("msg_1")).toBe(true);
    expect(rate.take("msg_1")).toBe(false);
    now += UNSUBSCRIBE_PER_MESSAGE_MS;
    expect(rate.take("msg_1")).toBe(true);
    for (let i = 0; i < UNSUBSCRIBE_PER_HOUR - 2; i++) expect(rate.take(`other_${i}`)).toBe(true);
    expect(rate.remaining()).toBe(0);
    expect(rate.allows("fresh")).toBe(false);
    expect(rate.take("fresh")).toBe(false);
    now += 3_600_000;
    expect(rate.remaining()).toBe(UNSUBSCRIBE_PER_HOUR);
    expect(rate.take("fresh")).toBe(true);
  });
});
