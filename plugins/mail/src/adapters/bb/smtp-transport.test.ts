import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import { afterEach, describe, expect, it } from "vitest";
import { GrantRevokedError, SendError, classifySendError, type SmtpConfig } from "../../core/index.ts";
import {
  createSmtpTransport,
  mapSendError,
  smtpOptions,
  type SmtpConnectionLike,
} from "./smtp-transport.ts";

const PASSWORD = "Invented-smtp-pa55word";
const RAW = new TextEncoder().encode(
  "From: owner@example.org\r\nTo: ana@example.com\r\nSubject: Invented\r\nMessage-ID: <m1@example.org>\r\n\r\nInvented body\r\n",
);

/** What the fake server does at each step. "drop": close without a reply; "hang": never answer. */
type Script = {
  auth?: string;
  mail?: string;
  rcpt?: (address: string) => string;
  data?: string;
  afterData?: string | "drop" | "hang";
};

type Recorded = { lines: string[]; data: string[] };

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  servers = [];
});

/** A plaintext SMTP server on 127.0.0.1 that follows `script`; records commands and message data. */
async function fakeServer(script: Script = {}): Promise<{ port: number; recorded: Recorded; sockets: Socket[] }> {
  const recorded: Recorded = { lines: [], data: [] };
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    let buffer = "";
    let inData = false;
    let data = "";
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 fake.example.org ESMTP");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          data += buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          inData = false;
          recorded.data.push(data);
          data = "";
          const after = script.afterData ?? "250 2.0.0 Ok queued";
          if (after === "drop") {
            socket.destroy();
            return;
          }
          if (after !== "hang") reply(after);
          continue;
        }
        const at = buffer.indexOf("\r\n");
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        recorded.lines.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") {
          reply("250-fake.example.org");
          reply("250-AUTH PLAIN LOGIN");
          reply("250 8BITMIME");
        } else if (verb === "AUTH") reply(script.auth ?? "235 2.7.0 Authentication successful");
        else if (verb === "MAIL") reply(script.mail ?? "250 2.1.0 Ok");
        else if (verb === "RCPT") {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? "";
          reply(script.rcpt ? script.rcpt(address) : "250 2.1.5 Ok");
        } else if (verb === "DATA") {
          const answer = script.data ?? "354 End data with <CR><LF>.<CR><LF>";
          reply(answer);
          if (answer.startsWith("354")) inData = true;
        } else if (verb === "QUIT") {
          reply("221 2.0.0 Bye");
          socket.end();
        } else if (verb === "RSET") reply("250 Ok");
        else reply("502 5.5.2 Unknown");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, recorded, sockets };
}

/** The real SMTPConnection, pointed at the local plaintext server (TLS cannot be tested locally). */
function localFactory(port: number, timeouts: { socketTimeout?: number } = {}) {
  return (options: ReturnType<typeof smtpOptions>): SmtpConnectionLike =>
    new SMTPConnection({
      ...options,
      host: "127.0.0.1",
      port,
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
      tls: undefined,
      ...timeouts,
    }) as unknown as SmtpConnectionLike;
}

function config(): SmtpConfig {
  return { host: "smtp.example.org", port: 465, security: "tls", username: "owner@example.org", password: PASSWORD };
}

const message = (to = ["ana@example.com"]) => ({ envelopeFrom: "owner@example.org", envelopeTo: to, raw: RAW });
const never = () => new AbortController().signal;

async function sendError(promise: Promise<unknown>): Promise<SendError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SendError);
    return error as SendError;
  }
  throw new Error("expected a SendError");
}

describe("smtpOptions", () => {
  it("is TLS on 465 and mandatory STARTTLS otherwise, certificates checked, logging off", () => {
    expect(smtpOptions({ host: "smtp.example.org", port: 465, security: "tls" })).toMatchObject({
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
      opportunisticTLS: false,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: "smtp.example.org" },
      logger: false,
      debug: false,
      transactionLog: false,
    });
    expect(smtpOptions({ host: "smtp.example.org", port: 587, security: "starttls" })).toMatchObject({
      secure: false,
      requireTLS: true,
    });
  });
});

describe("createSmtpTransport against a local server", () => {
  it("sends the exact bytes with the explicit envelope, then QUITs", async () => {
    const { port, recorded } = await fakeServer();
    const result = await createSmtpTransport({ factory: localFactory(port) }).send(
      config(),
      message(["ana@example.com", "hidden@example.net"]),
      never(),
    );
    expect(result).toEqual({ accepted: ["ana@example.com", "hidden@example.net"], rejected: [] });
    expect(recorded.lines.filter((l) => /^(MAIL|RCPT)/.test(l))).toEqual([
      "MAIL FROM:<owner@example.org>",
      "RCPT TO:<ana@example.com>",
      "RCPT TO:<hidden@example.net>",
    ]);
    expect(recorded.data).toEqual([new TextDecoder().decode(RAW)]);
    for (let i = 0; i < 100 && recorded.lines.at(-1) !== "QUIT"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(recorded.lines.at(-1)).toBe("QUIT");
  });

  it("reports partly refused recipients and still sends", async () => {
    const { port } = await fakeServer({
      rcpt: (address) => (address.startsWith("bad") ? "550 5.1.1 No such user" : "250 Ok"),
    });
    await expect(
      createSmtpTransport({ factory: localFactory(port) }).send(
        config(),
        message(["ana@example.com", "bad@example.com"]),
        never(),
      ),
    ).resolves.toEqual({ accepted: ["ana@example.com"], rejected: ["bad@example.com"] });
  });

  it("a Google account logs in with XOAUTH2 and its access token, never the refresh token", async () => {
    const { port, recorded } = await fakeServer();
    const asked: string[] = [];
    const transport = createSmtpTransport({
      factory: localFactory(port),
      googleTokens: {
        accessToken: async (refreshToken) => (asked.push(refreshToken), "a1"),
        narrowToken: async () => Promise.reject(new Error("not used")),
        exchangeCode: async () => ({ ok: false, reason: "other" }),
        forget: () => undefined,
      },
    });

    await transport.verify({ ...config(), password: "invented-refresh-token", authKind: "google" });

    expect(asked).toEqual(["invented-refresh-token"]);
    const auth = recorded.lines.filter((l) => l.startsWith("AUTH"));
    expect(auth).toHaveLength(1);
    expect(auth[0]!.startsWith("AUTH XOAUTH2 ")).toBe(true);
    expect(Buffer.from(auth[0]!.slice("AUTH XOAUTH2 ".length), "base64").toString("utf8")).toBe(
      "user=owner@example.org\u0001auth=Bearer a1\u0001\u0001",
    );
    const everything = recorded.lines.join("\n");
    expect(everything).not.toContain("invented-refresh-token");
    expect(everything).not.toContain(Buffer.from("invented-refresh-token").toString("base64"));
  });

  it("a revoked grant is an auth failure and an unreachable token endpoint a connection failure, before anything connects", async () => {
    const { port, recorded } = await fakeServer();
    const failing = (error: Error) =>
      createSmtpTransport({
        factory: localFactory(port),
        googleTokens: { accessToken: async () => { throw error; }, narrowToken: async () => Promise.reject(new Error("not used")), exchangeCode: async () => ({ ok: false, reason: "other" }), forget: () => undefined },
      });
    const google = { ...config(), password: "invented-refresh-token", authKind: "google" as const };

    expect((await sendError(failing(new GrantRevokedError()).verify(google))).kind).toBe("auth");
    expect((await sendError(failing(Object.assign(new Error("x"), { code: "TokenUnavailable" })).verify(google))).kind).toBe("connect");
    expect((await sendError(createSmtpTransport({ factory: localFactory(port) }).verify(google))).kind).toBe("connect");
    expect(recorded.lines).toEqual([]);
  });

  it("verify logs in and sends nothing", async () => {
    const { port, recorded } = await fakeServer();
    await createSmtpTransport({ factory: localFactory(port) }).verify(config());
    expect(recorded.lines.some((l) => /^(MAIL|RCPT|DATA)/.test(l))).toBe(false);
    expect(recorded.lines.some((l) => l.startsWith("AUTH"))).toBe(true);
  });

  it.each([
    ["535 refused login", { auth: "535 5.7.8 Authentication failed" }, "auth"],
    ["454 temporary login failure", { auth: "454 4.7.0 Try later" }, "temporary"],
    ["all recipients refused", { rcpt: (): string => "550 5.1.1 No such user" }, "rejected_all"],
    ["a 4xx recipient reply", { rcpt: (): string => "450 4.2.0 Busy" }, "temporary"],
    ["MAIL FROM 552", { mail: "552 5.3.4 Message too big" }, "too_large"],
    ["MAIL FROM 553", { mail: "553 5.7.1 Sender refused" }, "rejected_message"],
    ["DATA refused", { data: "554 5.5.1 No valid recipients" }, "rejected_message"],
  ] as const)("before DATA: %s → %s, nothing after DATA", async (_label, script, kind) => {
    const { port, recorded } = await fakeServer(script);
    const error = await sendError(
      createSmtpTransport({ factory: localFactory(port) }).send(config(), message(), never()),
    );
    expect(error.kind).toBe(kind);
    expect(error.afterData).toBe(false);
    expect(recorded.data).toEqual([]);
    expect(classifySendError(error).state).toBe("failed");
  });

  it.each([
    ["554 after the data", "554 5.7.1 Message rejected as spam", "rejected_message", "failed"],
    ["552 after the data", "552 5.3.4 Message too big", "too_large", "failed"],
    ["451 after the data", "451 4.3.0 Try again", "temporary", "failed"],
    ["a closed socket after the data", "drop", "unknown_after_data", "unknown"],
  ] as const)("after DATA: %s → %s", async (_label, afterData, kind, state) => {
    const { port, recorded } = await fakeServer({ afterData });
    const error = await sendError(
      createSmtpTransport({ factory: localFactory(port) }).send(config(), message(), never()),
    );
    expect(recorded.data).toHaveLength(1);
    expect(error.kind).toBe(kind);
    expect(error.afterData).toBe(true);
    expect(classifySendError(error).state).toBe(state);
  });

  it("a timeout after the data is unknown_after_data", async () => {
    const { port } = await fakeServer({ afterData: "hang" });
    const error = await sendError(
      createSmtpTransport({ factory: localFactory(port, { socketTimeout: 200 }) }).send(config(), message(), never()),
    );
    expect(error).toMatchObject({ kind: "unknown_after_data", afterData: true });
  });

  it("an abort after the data started is unknown_after_data", async () => {
    const { port, recorded } = await fakeServer({ afterData: "hang" });
    const controller = new AbortController();
    const sending = createSmtpTransport({ factory: localFactory(port) }).send(config(), message(), controller.signal);
    for (let i = 0; i < 100 && recorded.data.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    expect(await sendError(sending)).toMatchObject({ kind: "unknown_after_data", afterData: true });
  });

  it("an abort before anything was sent is timeout_before_data", async () => {
    const { port, recorded } = await fakeServer();
    const controller = new AbortController();
    controller.abort();
    const error = await sendError(
      createSmtpTransport({ factory: localFactory(port) }).send(config(), message(), controller.signal),
    );
    expect(error).toMatchObject({ kind: "timeout_before_data", afterData: false });
    expect(recorded.data).toEqual([]);
  });

  it("a refused connection is connect", async () => {
    const { port } = await fakeServer();
    await new Promise((resolve) => servers.pop()!.close(resolve));
    const error = await sendError(
      createSmtpTransport({ factory: localFactory(port) }).send(config(), message(), never()),
    );
    expect(error).toMatchObject({ kind: "connect", afterData: false });
  });

  it("no error carries the password or the server's reply text", async () => {
    const { port } = await fakeServer({ afterData: "554 5.7.1 Secret reply text" });
    const error = await sendError(
      createSmtpTransport({ factory: localFactory(port) }).send(config(), message(), never()),
    );
    const shown = `${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
    expect(shown).not.toContain("Secret reply text");
    expect(shown).not.toContain(PASSWORD);
    expect(shown).not.toContain("ana@example.com");
  });
});

describe("mapSendError", () => {
  it.each([
    [{ code: "ETLS" }, false, "tls"],
    [{ code: "ESOCKET", originalCode: "DEPTH_ZERO_SELF_SIGNED_CERT" }, false, "tls"],
    [{ code: "ESOCKET", originalCode: "ERR_TLS_CERT_ALTNAME_INVALID" }, false, "tls"],
    [{ code: "EDNS", originalCode: "ENOTFOUND" }, false, "connect"],
    [{ code: "ECONNECTION", originalCode: "ECONNREFUSED" }, false, "connect"],
    [{ code: "ETIMEDOUT", command: "CONN" }, false, "timeout_before_data"],
    [{ code: "EAUTH", responseCode: 535 }, false, "auth"],
    [{ code: "EAUTH", responseCode: 534 }, false, "auth"],
    [{ code: "EMESSAGE", command: "MAIL FROM" }, false, "too_large"],
    [{ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }, false, "rejected_all"],
    [{ code: "EENVELOPE", command: "MAIL FROM", responseCode: 421 }, false, "temporary"],
    [{ code: "ETIMEDOUT" }, true, "unknown_after_data"],
    [{ code: "ECONNECTION" }, true, "unknown_after_data"],
    [{ code: "EABORT" }, true, "unknown_after_data"],
    [{ code: "EMESSAGE", command: "DATA", responseCode: 554 }, true, "rejected_message"],
    [{ code: "ECONNECTION", responseCode: 421 }, true, "temporary"],
    [new Error("anything"), true, "unknown_after_data"],
    [null, false, "connect"],
  ] as const)("%j (data started: %s) → %s", (error, started, kind) => {
    const mapped = mapSendError(error, started);
    expect(mapped.kind).toBe(kind);
    expect(mapped.afterData).toBe(started);
  });

  it.each([
    [{ code: "EENVELOPE", command: "MAIL FROM", responseCode: 550 }, false, "rejected_message", "MAIL FROM"],
    [{ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }, false, "rejected_all", "RCPT TO"],
    [{ code: "EMESSAGE", command: "MAIL FROM" }, false, "too_large", "MAIL FROM"],
    [{ code: "EMESSAGE", command: "DATA", responseCode: 554 }, true, "rejected_message", "DATA"],
    [{ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 }, false, "auth", null],
    [{ code: "ETIMEDOUT", command: "CONN" }, false, "timeout_before_data", null],
    [null, false, "connect", null],
  ] as const)("%j (data started: %s) → %s, command %s", (error, started, kind, command) => {
    const mapped = mapSendError(error, started);
    expect(mapped.kind).toBe(kind);
    expect(mapped.command).toBe(command);
  });

  it("nothing after the data started is a before-DATA kind", () => {
    for (const code of ["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ETLS", "EAUTH", "EABORT", "EPROTOCOL"]) {
      expect(["connect", "tls", "auth", "timeout_before_data"]).not.toContain(mapSendError({ code }, true).kind);
    }
  });
});
