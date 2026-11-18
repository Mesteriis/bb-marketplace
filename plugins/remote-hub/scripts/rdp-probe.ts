// Throwaway live probe for an RDP endpoint (not part of the plugin bundle).
//
//   node --experimental-transform-types scripts/rdp-probe.ts <host> <port> <username> [<domain>]
//        [--accept-fingerprint <sha256>] [--timeout-s N] [--helper <path>]
//
// (The flag is needed because the plugin sources use TypeScript parameter
// properties, which Node's strip-only mode does not run.)
// The PASSWORD IS READ FROM STDIN ONLY (first line): never argv, never an
// environment variable, never echoed or logged. The probe starts the real helper
// through the service code path, prints one line per state change and the close
// reason, answers a certificate prompt only for the exact fingerprint given with
// --accept-fingerprint (accept once, nothing is persisted), then closes the
// session — a disconnect, never a logoff — and exits.
//
// Exit code: 0 desktop_ready, 2 auth_failed, 3 anything else.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HelperProcess } from "../src/adapters/bb/helper-process.ts";
import { createRemoteHubService } from "../src/adapters/bb/service.ts";
import { fingerprintEqual, normalizeFingerprint } from "../src/core/rdp-trust.ts";

interface Args {
  host: string;
  port: number;
  username: string;
  domain: string | undefined;
  acceptFingerprint: string | null;
  timeoutS: number;
  helper: string;
}

function fail(message: string): never {
  process.stderr.write("rdp-probe: " + message + "\n");
  process.exit(3);
}

export function parseArgs(argv: string[], defaultHelper: string): Args {
  const positional: string[] = [];
  let acceptFingerprint: string | null = null;
  let timeoutS = 60;
  let helper = defaultHelper;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--accept-fingerprint") {
      const value = argv[++i] ?? "";
      const normalized = normalizeFingerprint(value);
      if (normalized === null) fail("--accept-fingerprint needs a SHA-256 fingerprint (64 hex digits, colons optional)");
      acceptFingerprint = normalized;
    } else if (arg === "--timeout-s") {
      timeoutS = Number(argv[++i]);
      if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 600) fail("--timeout-s needs an integer 1..600");
    } else if (arg === "--helper") {
      helper = argv[++i] ?? "";
    } else if (arg.startsWith("--")) {
      fail("unknown option " + arg);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length < 3 || positional.length > 4) fail("usage: rdp-probe <host> <port> <username> [<domain>] [options]; the password comes from stdin");
  const port = Number(positional[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("port must be an integer 1..65535");
  return { host: positional[0], port, username: positional[2], domain: positional[3], acceptFingerprint, timeoutS, helper };
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) fail("the password must be piped on stdin (it is never read from the terminal prompt or argv)");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const line = Buffer.concat(chunks).toString("utf8").split("\n")[0].replace(/\r$/, "");
  if (line.length === 0) fail("no password on stdin");
  return line;
}

const say = (line: string): void => void process.stdout.write(line + "\n");
// The attach snapshot and the live events can both carry the same state: print each change once.
let lastState: string | null = null;
const sayState = (state: string): void => {
  if (state === lastState) return;
  lastState = state;
  say("state: " + state);
};

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultHelper = process.env.REMOTE_HUB_HELPER ?? join(here, "..", "bin", "remote-hub-helper");
  const args = parseArgs(process.argv.slice(2), defaultHelper);
  if (!existsSync(args.helper)) fail("helper binary not found at " + args.helper + " (run 'npm run build:helper')");
  const password = await readPassword();

  const service = createRemoteHubService({
    startHelper: () =>
      HelperProcess.spawn(args.helper, (bin, a) =>
        // An empty environment, plus the test engine selector (a release helper ignores it).
        spawn(bin, a, {
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env.REMOTE_HUB_RDP_FAKE_ENGINE ? { REMOTE_HUB_RDP_FAKE_ENGINE: process.env.REMOTE_HUB_RDP_FAKE_ENGINE } : {},
        }) as never,
      ),
  });

  let exitCode: number | null = null;
  let handleRef: { generation: string; sessionId: number } | null = null;
  const finish = async (code: number): Promise<void> => {
    if (exitCode !== null) return;
    exitCode = code;
    if (handleRef !== null) await service.sessionClose(handleRef).catch(() => {});
    service.stop();
    // Let the helper reap its engine before this process goes away.
    setTimeout(() => process.exit(code), 300);
  };

  const timer = setTimeout(() => {
    say("timeout: no desktop within " + args.timeoutS + " s");
    void finish(3);
  }, args.timeoutS * 1000);
  timer.unref();

  let handle;
  try {
    handle = await service.rdpOpen(
      { host: args.host, port: args.port, username: args.username, password, domain: args.domain },
      1280,
      800,
    );
  } catch (error) {
    say("open failed: " + (error instanceof Error ? error.message : "error"));
    return void (await finish(3));
  }
  handleRef = handle;

  const promptHandled = new Set<string>();
  const onPrompt = (prompt: { fingerprint: string; subject: string; issuer: string; notBefore: string; notAfter: string; reason: string }): void => {
    if (promptHandled.has(prompt.fingerprint)) return;
    promptHandled.add(prompt.fingerprint);
    say(
      "cert_prompt: fingerprint=" + prompt.fingerprint + " subject=" + prompt.subject + " issuer=" + prompt.issuer +
        " valid=" + prompt.notBefore + ".." + prompt.notAfter + " reason=" + prompt.reason,
    );
    if (args.acceptFingerprint !== null && fingerprintEqual(prompt.fingerprint, args.acceptFingerprint)) {
      say("cert_decision: accept once (the fingerprint matches --accept-fingerprint)");
      void service.rdpCertDecision(handle, prompt.fingerprint, "once").catch(() => {});
    } else {
      say(args.acceptFingerprint === null ? "cert_decision: reject (no --accept-fingerprint given)" : "cert_decision: reject (the fingerprint differs from --accept-fingerprint)");
      void service.rdpCertDecision(handle, prompt.fingerprint, "reject").catch(() => {});
    }
  };

  service.subscribeSessionEnd(handle, (info) => {
    say("closed: reason=" + info.reason);
    void finish(info.reason === "auth_failed" ? 2 : 3);
  });

  let attachment: ReturnType<typeof service.rdpAttach>;
  attachment = service.rdpAttach(handle, "probe", {
    sendUpdate(payload) {
      // The first 8 bytes are the little-endian frame id; ack so the helper keeps painting.
      const frameId = Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, true));
      attachment.ack(frameId);
    },
    sendEvent(event) {
      if (event.type === "state") sayState(String(event.state));
      else if (event.type === "cert_prompt") onPrompt(event.prompt as Parameters<typeof onPrompt>[0]);
      else if (event.type === "desktop") {
        say("desktop_ready: " + String(event.width) + "x" + String(event.height));
        void finish(0);
      }
    },
  });
  // The attach snapshot may already carry the state and a pending prompt.
  const initial = attachment.initial as { state: string; prompt: Parameters<typeof onPrompt>[0] | null; desktop: { width: number; height: number } | null };
  sayState(initial.state);
  if (initial.prompt !== null) onPrompt(initial.prompt);
  if (initial.desktop !== null) {
    say("desktop_ready: " + initial.desktop.width + "x" + initial.desktop.height);
    void finish(0);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write("rdp-probe: " + (error instanceof Error ? error.constructor.name : "error") + "\n");
    process.exit(3);
  });
}
