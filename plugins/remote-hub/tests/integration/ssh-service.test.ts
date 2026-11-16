// Node integration for Remote Hub: drives the real TS layer (service.ts +
// helper-process.ts) against the real Rust helper and a throwaway sshd
// container. The spawn primitive is injected (node:child_process.spawn), which
// is exactly what the SDK's experimental_spawnHostProcess wraps. Run via the
// test:integration script; without REMOTE_HUB_INTEGRATION=1 the cases are
// skipped so 'npm run check' stays offline.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCreditController } from "../../src/core/credit.ts";
import { HelperProcess } from "../../src/adapters/bb/helper-process.ts";
import { createRemoteHubService, type RemoteHubService } from "../../src/adapters/bb/service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER =
  process.env.REMOTE_HUB_HELPER ??
  join(here, "..", "..", "bin", "remote-hub-helper");
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

const spawnHelper = (bin: string) =>
  HelperProcess.spawn(
    bin,
    (b, args) => spawn(b, args, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildProcessWithoutNullStreams,
  );

const runDocker = enabled && dockerAvailable();

// The standalone integration path must fail loudly (not silently pass) when
// Docker is requested but unavailable.
it("docker is available when integration is requested", () => {
  if (enabled && !dockerAvailable()) {
    console.log("not run");
    throw new Error("not run: docker unavailable");
  }
});

describe.skipIf(!runDocker)("ssh service integration (service.ts + helper-process.ts)", () => {
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

    helper = await spawnHelper(HELPER);
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

  const target = (kh: string) => ({
    host: "127.0.0.1",
    port,
    configFile: cfg,
    knownHostsFile: kh,
    identityFile: key,
    extraOptions: [] as string[],
  });

  function creditFlow(handle: { generation: string; sessionId: number }, service: RemoteHubService) {
    const credit = createCreditController();
    const decoder = new TextDecoder();
    let out = "";
    let replenishError: unknown = null;
    void service.sessionCredit(handle, credit.attach()).catch((e) => {
      replenishError = e;
    });
    const unsub = service.subscribeSession(handle, (data) => {
      out += decoder.decode(data, { stream: true });
      const replenish = credit.consumed(data.byteLength);
      if (replenish > 0) {
        void service.sessionCredit(handle, replenish).catch((e) => {
          replenishError = e;
        });
      }
    });
    return { out: () => out, unsub, replenishError: () => replenishError };
  }

  it("case 1: key auth echoes a UTF-8 line without a manual credit grant", async () => {
    const handle = await service.sshOpen(target(knownHosts), 80, 24);
    const flow = creditFlow(handle, service);
    await service.sessionTerminalInput(
      handle,
      new TextEncoder().encode("printf 'h\u00e9llo-ok'\n"),
    );
    await waitFor(() => flow.out().includes("h\u00e9llo-ok"));
    flow.unsub();
    expect(flow.replenishError()).toBeNull();
    expect(flow.out()).toContain("h\u00e9llo-ok");
  });

  it("case 5: unknown host key prompts, runs nothing, and no closes with 255 ssh_error", async () => {
    const emptyKh = join(tmp, "empty_known_hosts");
    writeFileSync(emptyKh, "");
    const handle = await service.sshOpen(target(emptyKh), 80, 24);
    const flow = creditFlow(handle, service);
    await waitFor(() => flow.out().includes("Are you sure you want to continue connecting"));
    expect(flow.out()).not.toContain("Welcome to Alpine");
    expect(flow.out()).not.toContain("~#");

    await service.sessionTerminalInput(handle, new TextEncoder().encode("no\n"));
    await waitFor(() => {
      const s = service.sessionList().find((x) => x.generation === handle.generation && x.sessionId === handle.sessionId);
      return s?.state === "closed";
    });
    const info = service.sessionList().find((x) => x.generation === handle.generation && x.sessionId === handle.sessionId);
    expect(info?.exitCode).toBe(255);
    expect(info?.reason).toBe("ssh_error");
    expect(statSync(emptyKh).size).toBe(0);
    flow.unsub();
  });
});

describe.skipIf(!enabled)("credit flow through the helper (no manual grant)", () => {
  it("receives PROBE-42 from /bin/sh with only the credit controller", async () => {
    const hp = await spawnHelper(HELPER);
    const handle = await hp.openSsh(
      {
        program: "/bin/sh",
        argv: ["sh", "-c", "echo PROBE-$((6*7))"],
        env: { TERM: "xterm-256color" },
      },
      80,
      24,
    );
    const credit = createCreditController();
    const decoder = new TextDecoder();
    let out = "";
    hp.onSessionOutput((sessionId, data) => {
      if (sessionId !== handle.sessionId) return;
      out += decoder.decode(data, { stream: true });
      const replenish = credit.consumed(data.byteLength);
      if (replenish > 0) {
        void hp.credit(handle, replenish).catch(() => {});
      }
    });
    await hp.credit(handle, credit.attach());
    await waitFor(() => out.includes("PROBE-42"));
    expect(out).toContain("PROBE-42");
    hp.stop();
  });
});
