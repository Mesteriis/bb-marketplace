// The live-probe script against the real (test-hooks) helper: a synthetic engine
// for the success path and a closed port for the failure path. No Docker.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = process.env.REMOTE_HUB_HELPER ?? join(here, "..", "..", "bin", "remote-hub-helper");
const PROBE = join(here, "..", "..", "scripts", "rdp-probe.ts");
const enabled = process.env.REMOTE_HUB_INTEGRATION === "1";
const SECRET = "S3cr3t-MARK-91";

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function runProbe(args: string[], env: Record<string, string>, stdin: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["--experimental-transform-types", "--no-warnings", PROBE, ...args], {
      env: { PATH: process.env.PATH ?? "", REMOTE_HUB_HELPER: HELPER, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("exit", (code) => resolve({ code, out }));
    child.stdin.end(stdin);
  });
}

describe.skipIf(!enabled)("rdp-probe", () => {
  it("reaches desktop_ready against a synthetic engine: exit 0, one line per state, no password in the output", async () => {
    const { code, out } = await runProbe(["127.0.0.1", "3389", "alice", "--timeout-s", "30"], { REMOTE_HUB_RDP_FAKE_ENGINE: "ack" }, SECRET + "\n");
    expect(out).not.toContain(SECRET);
    expect(out).toContain("desktop_ready: 1280x800");
    expect(out).toMatch(/^state: connecting$/m);
    expect(out).toMatch(/^state: authenticating$/m);
    expect(code).toBe(0);
  }, 60_000);

  it("a closed port is closed network_error: exit 3, no password in the output", async () => {
    const port = await closedPort();
    const { code, out } = await runProbe(["127.0.0.1", String(port), "alice", "CORP", "--timeout-s", "30"], {}, SECRET + "\n");
    expect(out).not.toContain(SECRET);
    expect(out).toContain("closed: reason=network_error");
    expect(code).toBe(3);
  }, 60_000);

  it("refuses to run without a piped password and never takes it from argv", async () => {
    const { code, out } = await runProbe(["127.0.0.1", "3389", "alice", SECRET, "--bogus"], {}, "");
    expect(code).toBe(3);
    expect(out).not.toContain(SECRET); // the unknown option is reported, the value is not echoed
  }, 30_000);

  it("rejects an empty password on stdin", async () => {
    const { code, out } = await runProbe(["127.0.0.1", "3389", "alice"], {}, "\n");
    expect(code).toBe(3);
    expect(out).toContain("no password on stdin");
  }, 30_000);
});
