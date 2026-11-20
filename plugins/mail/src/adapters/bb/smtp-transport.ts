// MailTransport on nodemailer's SMTPConnection: one connection per verify or
// send, closed after it, TLS always (implicit TLS on 465, mandatory STARTTLS
// otherwise; there is no plaintext option), certificates verified, nodemailer
// logging off. The low-level connection is used instead of createTransport so
// the adapter knows exactly when the message data started (the server
// answered DATA and the bytes began to flow): from then on a lost connection,
// a timeout or an abort is `unknown_after_data`, never a retryable failure.
// Errors leave as SendError (a kind, afterData and the refused command's
// fixed name only): the server's reply
// text is never kept, logged or passed on.
import { Readable } from "node:stream";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import type { SMTPConnectionOptions } from "nodemailer/lib/smtp-connection";
import {
  SendError,
  type MailTransport,
  type SendErrorKind,
  type SendResult,
  type SmtpCommand,
  type SmtpConfig,
} from "../../core/index.ts";
import { GrantRevokedError } from "../../core/ports.ts";
import type { GoogleTokens } from "./google-tokens.ts";

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;

type Callback<T = unknown> = (error: Error | null, result?: T) => void;

/** What the transport uses of an SMTPConnection; tests pass one pointed at a local server. */
export interface SmtpConnectionLike {
  on(event: "error", listener: (error: Error) => void): unknown;
  connect(callback: (error?: Error | null) => void): void;
  login(auth: { user: string; pass: string }, callback: Callback): void;
  send(
    envelope: { from: string; to: string[] },
    message: Readable,
    callback: Callback<{ accepted: unknown[]; rejected: unknown[] }>,
  ): void;
  quit(): void;
  close(): void;
}

export type SmtpConnectionFactory = (options: SMTPConnectionOptions) => SmtpConnectionLike;

const defaultFactory: SmtpConnectionFactory = (options) =>
  new SMTPConnection(options) as unknown as SmtpConnectionLike;

/** Connection options for a config; exported for the option test. */
export function smtpOptions(config: Pick<SmtpConfig, "host" | "port" | "security">): SMTPConnectionOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    ignoreTLS: false,
    opportunisticTLS: false,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: config.host },
    // The EHLO name: an address literal instead of this machine's host name.
    name: "[127.0.0.1]",
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    logger: false,
    debug: false,
    transactionLog: false,
  };
}

/** The shape of nodemailer's errors: a code, the reply's status code, the command in flight. */
type SmtpErrorFields = {
  code?: unknown;
  originalCode?: unknown;
  responseCode?: unknown;
  command?: unknown;
};

const TLS_CODE = /TLS|SSL|CERT|ALTNAME|HANDSHAKE/i;

/**
 * A nodemailer failure as a SendError. Before the data started: 4xx →
 * temporary, AUTH refused → auth, TLS → tls, a timeout or abort →
 * timeout_before_data, every RCPT refused → rejected_all, 552 or SIZE →
 * too_large, another 5xx → rejected_message, the rest → connect. After it:
 * 552 → too_large, 4xx → temporary, 5xx → rejected_message, and no reply
 * at all (a lost connection, a timeout, an abort) → unknown_after_data.
 */
const SMTP_COMMANDS: readonly SmtpCommand[] = ["MAIL FROM", "RCPT TO", "DATA"];

export function mapSendError(error: unknown, dataStarted: boolean): SendError {
  const fields = (error ?? {}) as SmtpErrorFields;
  const code = typeof fields.code === "string" ? fields.code : "";
  const originalCode = typeof fields.originalCode === "string" ? fields.originalCode : "";
  const status = typeof fields.responseCode === "number" ? fields.responseCode : 0;
  const command = typeof fields.command === "string" ? fields.command : "";
  // The refused command as a fixed string (slice 3d: the core decides sender_refused from it).
  const refused: SmtpCommand | null = SMTP_COMMANDS.find((c) => c === command.toUpperCase()) ?? null;
  const kind = (k: SendErrorKind) => new SendError(k, dataStarted, refused);

  if (dataStarted) {
    if (status === 552) return kind("too_large");
    if (status >= 400 && status < 500) return kind("temporary");
    if (status >= 500 && status < 600) return kind("rejected_message");
    return kind("unknown_after_data");
  }
  if (status >= 400 && status < 500) return kind("temporary");
  if (code === "EAUTH") return kind("auth");
  if (code === "ETLS" || TLS_CODE.test(originalCode) || (code !== "" && TLS_CODE.test(code))) return kind("tls");
  if (code === "ETIMEDOUT" || code === "EABORT") return kind("timeout_before_data");
  if (status === 552 || (code === "EMESSAGE" && command === "MAIL FROM")) return kind("too_large");
  if (code === "EENVELOPE" && command === "RCPT TO") return kind("rejected_all");
  if (status >= 500 && status < 600) return kind("rejected_message");
  return kind("connect");
}

/** The message bytes as a stream that reports when the connection starts reading it. */
function trackedMessage(raw: Uint8Array, onStart: () => void): Readable {
  const stream = Readable.from([Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)]);
  const pipe = stream.pipe.bind(stream);
  stream.pipe = ((destination: NodeJS.WritableStream, options?: { end?: boolean }) => {
    onStart();
    return pipe(destination, options);
  }) as typeof stream.pipe;
  return stream;
}

function abortError(): Error {
  return Object.assign(new Error("Aborted"), { code: "EABORT" });
}

/** nodemailer's XOAUTH2 login for one access token; a second try after a refusal is declined. */
function xoauth2Login(user: string, accessToken: string): unknown {
  return {
    type: "OAuth2",
    method: "XOAUTH2",
    user,
    oauth2: {
      getToken: (isRetry: boolean, callback: (error: Error | null, token?: string) => void) =>
        isRetry ? callback(new Error("Token refused")) : callback(null, accessToken),
      buildXOAuth2Token: (token: string) =>
        Buffer.from(`user=${user}\u0001auth=Bearer ${token}\u0001\u0001`, "utf8").toString("base64"),
    },
  };
}

export function createSmtpTransport(
  options: { factory?: SmtpConnectionFactory; googleTokens?: GoogleTokens } = {},
): MailTransport {
  const factory = options.factory ?? defaultFactory;

  /**
   * What the connection logs in with: the password, or for a Google account
   * an access token. A revoked grant is an auth failure; no token now is a
   * connection failure, so the Outbox tries again later.
   */
  async function loginFor(config: SmtpConfig): Promise<unknown> {
    if (config.authKind !== "google") return { user: config.username, pass: config.password };
    try {
      if (options.googleTokens === undefined) throw new Error("No token service");
      return xoauth2Login(config.username, await options.googleTokens.accessToken(config.password));
    } catch (error) {
      throw new SendError(error instanceof GrantRevokedError ? "auth" : "connect", false, null);
    }
  }

  /** Connects, logs in, runs `then` and closes; every failure goes through mapSendError. */
  async function session<T>(
    config: SmtpConfig,
    signal: AbortSignal | null,
    then: (connection: SmtpConnectionLike, done: (error: Error | null, result?: T) => void, started: () => void) => void,
  ): Promise<T> {
    return connected(config, await loginFor(config), signal, then);
  }

  function connected<T>(
    config: SmtpConfig,
    auth: unknown,
    signal: AbortSignal | null,
    then: (connection: SmtpConnectionLike, done: (error: Error | null, result?: T) => void, started: () => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let dataStarted = false;
      let settled = false;
      const connection = factory(smtpOptions(config));
      const finish = (error: Error | null, result?: T) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        try {
          if (error === null) connection.quit();
          else connection.close();
        } catch {
          // Already closed.
        }
        if (error === null) resolve(result as T);
        else reject(mapSendError(error, dataStarted));
      };
      const onAbort = () => finish(abortError());
      // An unhandled 'error' event would crash the host process.
      connection.on("error", (error) => finish(error));
      if (signal?.aborted) {
        finish(abortError());
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        connection.connect((error) => {
          if (error) return finish(error);
          if (settled) return;
          connection.login(auth as { user: string; pass: string }, (loginError) => {
            if (loginError) return finish(loginError);
            if (settled) return;
            then(connection, finish, () => {
              dataStarted = true;
            });
          });
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error("SMTP failed"));
      }
    });
  }

  return {
    verify(config) {
      return session<void>(config, null, (_connection, done) => done(null));
    },

    send(config, message, signal) {
      return session<SendResult>(config, signal, (connection, done, started) => {
        connection.send(
          { from: message.envelopeFrom, to: [...message.envelopeTo] },
          trackedMessage(message.raw, started),
          (error, info) => {
            if (error) return done(error);
            done(null, {
              accepted: (info?.accepted ?? []).map(String),
              rejected: (info?.rejected ?? []).map(String),
            });
          },
        );
      });
    },
  };
}
