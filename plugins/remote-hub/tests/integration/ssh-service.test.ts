// Node integration for Remote Hub: drives the real TS layer (service.ts +
// helper-process.ts) against the real Rust helper and a throwaway sshd
// container. Only the spawn primitive is injected (node:child_process.spawn),
// which is exactly what the SDK's experimental_spawnHostProcess wraps. Run via
// REMOTE_HUB_INTEGRATION=1 vitest run tests/integration/ssh-service.test.ts;
// without that env var the suite is skipped so 'npm run check' stays offline.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HelperProcess } from "../../src/adapters/bb/helper-process.ts";
import { createRemoteHubService, type RemoteHubService } from "../../src/adapters/bb/service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = join(here, "..", "..", "bin", "remote-hub-helper");
const IMAGE = "remote-hub-sshd-test";

const enabled = process.env.REMOTE_HUB_INTEGRATION === "1";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
  return !r.error && r.status === 0;
}

function freePort(): Promise<number> {
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

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

const runIt = enabled && dockerAvailable();

describe.skipIf(!runIt)("ssh service integration (service.ts + helper-process.ts)", () => {
  let tmp: string;
  let cid: string;
  let port: number;
  let key: string;
  let knownHosts: string;
  let cfg: string;
  let helper: HelperProcess;
  let service: RemoteHubService;

  beforeAll(async () => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, here], { stdio: "ignore" });
    tmp = mkdtempSync(join(tmpdir(), "rh-"));
    key = join(tmp, "id_ed25519");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key, "-q"]);
    port = await freePort();
    cid = execFileSync("docker", ["run", "-d", "-p", "127.0.0.1:" + port + ":22", IMAGE])
      .toString()
      .trim();
    const pub = execFileSync("cat", [key + ".pub"]);
    execFileSync(
      "docker",
      ["exec", "-i", cid, "sh", "-c", "mkdir -p /root/.ssh && cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"],
      { input: pub },
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const hostkey = execFileSync("docker", ["exec", cid, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"])
      .toString()
      .trim();
    knownHosts = join(tmp, "known_hosts");
    writeFileSync(knownHosts, "[127.0.0.1]:" + port + " " + hostkey + "\n");
    cfg = join(tmp, "config");
    writeFileSync(cfg, "Host rh\n");

    helper = await HelperProcess.spawn(
      HELPER,
      (bin, args) => spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildProcessWithoutNullStreams,
    );
    service = createRemoteHubService({
      startHelper: async () => helper,
      env: process.env as Record<string, string | undefined>,
    });
  }, 120_000);

  afterAll(() => {
    service.stop();
    if (cid) {
      spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("case 1: key auth echoes a UTF-8 line through the TS service", async () => {
    const target = {
      host: "127.0.0.1",
      port,
      configFile: cfg,
      knownHostsFile: knownHosts,
      identityFile: key,
      extraOptions: [],
    };
    const handle = await service.sshOpen(target, 80, 24);
    await service.sessionCredit(handle, 1 << 20);

    const decoder = new TextDecoder();
    let out = "";
    const unsub = service.subscribeSession(handle.sessionId, (data) => {
      out += decoder.decode(data, { stream: true });
    });
    await service.sessionTerminalInput(
      handle.sessionId,
      new TextEncoder().encode("printf 'h\u00e9llo-ok'\n"),
    );
    await waitFor(() => out.includes("h\u00e9llo-ok"));
    unsub();
    expect(out).toContain("h\u00e9llo-ok");
  });

  it("case 5: unknown host key prompts, runs nothing, and no closes with 255 ssh_error", async () => {
    const emptyKh = join(tmp, "empty_known_hosts");
    writeFileSync(emptyKh, "");
    const target = {
      host: "127.0.0.1",
      port,
      configFile: cfg,
      knownHostsFile: emptyKh,
      identityFile: key,
      extraOptions: [],
    };
    const handle = await service.sshOpen(target, 80, 24);
    await service.sessionCredit(handle, 1 << 20);

    const decoder = new TextDecoder();
    let out = "";
    const unsub = service.subscribeSession(handle.sessionId, (data) => {
      out += decoder.decode(data, { stream: true });
    });
    await waitFor(() => out.includes("Are you sure you want to continue connecting"));
    // The remote shell must not have started before the question is answered.
    expect(out).not.toContain("Welcome to Alpine");
    expect(out).not.toContain("~#");

    await service.sessionTerminalInput(handle.sessionId, new TextEncoder().encode("no\n"));
    await waitFor(() => {
      const s = service.sessionList().find((x) => x.sessionId === handle.sessionId);
      return s?.state === "closed";
    });
    const info = service.sessionList().find((x) => x.sessionId === handle.sessionId);
    expect(info?.exitCode).toBe(255);
    expect(info?.reason).toBe("ssh_error");
    expect(statSync(emptyKh).size).toBe(0);
    unsub();
  });
});

if (enabled && !runIt) {
  // Keeps the standalone REMOTE_HUB_INTEGRATION=1 path honest when Docker is
  // missing: it is reported, not silently passed.
  console.log("not run");
}
