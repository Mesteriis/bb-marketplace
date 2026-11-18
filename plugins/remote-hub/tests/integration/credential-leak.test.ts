// A saved credential and a typed password through the REAL service, the REAL helper
// and a REAL temporary keychain (opened by path by the test-hooks helper), against
// a throwaway xrdp container. After a use-once open and a saved-credential open, no
// channel may contain either secret: helper stderr, the service's session list, the
// credential list, the profile rows, error texts, and the argv and environment of
// the helper and its engine. (The sentinels are only ever compared, never printed.)
// Needs docker and REMOTE_HUB_INTEGRATION=1; a 120 s watchdog aborts a hung run.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HelperProcess } from "../../src/adapters/bb/helper-process.ts";
import { createRemoteHubService, type RemoteHubService } from "../../src/adapters/bb/service.ts";
import { CredentialBook, CredentialError, type CredentialMeta, type CredentialMetaStore } from "../../src/core/credential.ts";
import { ProfileBook, type ProfileStore } from "../../src/core/profile-book.ts";
import type { Profile } from "../../src/core/profile.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = process.env.REMOTE_HUB_HELPER ?? join(here, "..", "..", "bin", "remote-hub-helper");
const IMAGE = "remote-hub-rdp-test";
const enabled = process.env.REMOTE_HUB_INTEGRATION === "1";
const dockerOk = enabled && !spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).error;

const TYPED = "S3cr3t-TYPED-" + randomBytes(6).toString("hex");
const SAVED = "S3cr3t-SAVED-" + randomBytes(6).toString("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

async function waitTcp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createConnection({ host: "127.0.0.1", port }, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error("xrdp did not accept connections");
    await sleep(500);
  }
}

async function poll<T>(fn: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out: " + what);
    await sleep(100);
  }
}

class MemoryProfiles implements ProfileStore {
  rows = new Map<string, Profile>();
  all = () => [...this.rows.values()];
  get = (id: string) => this.rows.get(id) ?? null;
  put = (p: Profile) => void this.rows.set(p.id, p);
  remove = (id: string) => this.rows.delete(id);
}
class MemoryMeta implements CredentialMetaStore {
  rows = new Map<string, CredentialMeta>();
  all = () => [...this.rows.values()];
  get = (ref: string) => this.rows.get(ref) ?? null;
  put = (m: CredentialMeta) => void this.rows.set(m.ref, m);
  remove = (ref: string) => this.rows.delete(ref);
}

/** Every helper or engine process on this machine: [pid, argv text]. (Matched by name: the engine is exec'd by its resolved path.) */
function ourProcesses(): Array<[number, string]> {
  const out = spawnSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && m[2].includes("remote-hub-helper"))
    .map((m) => [Number(m[1]), m[2]]);
}

/** The environment of a process as text, for a boolean "does it contain X" check only. */
function environmentText(pid: number): string {
  return spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
}

describe.skipIf(!dockerOk)("a saved credential and a typed password leak into no channel", () => {
  let cid = "";
  let port = 0;
  let dir = "";
  let service: RemoteHubService;
  let stderr = "";
  const watchdog = setTimeout(() => process.abort(), 120_000);

  beforeAll(async () => {
    // The helper must be a test-hooks build: without the hook it would use the REAL login
    // keychain, which no test may touch. Refuse before anything is saved.
    if (!readFileSync(HELPER).includes("REMOTE_HUB_KEYCHAIN_PATH")) {
      throw new Error("REMOTE_HUB_HELPER is not a test-hooks build: build it with cargo build --features test-hooks");
    }
    execFileSync("docker", ["build", "-q", "-t", IMAGE, "-f", join(here, "rdp-Dockerfile"), here], { stdio: "ignore" });
    port = await freePort();
    cid = execFileSync("docker", ["run", "-d", "-e", "RDP_USER=rdptest", "-e", "RDP_PASSWORD=" + TYPED, "-p", `127.0.0.1:${port}:3389`, IMAGE], { encoding: "utf8" }).trim();
    await waitTcp(port, 60_000);
    await sleep(2000);
    dir = mkdtempSync(join(tmpdir(), "rh-leak-"));
    const env = { REMOTE_HUB_KEYCHAIN_PATH: join(dir, "kc.keychain-db"), REMOTE_HUB_KEYCHAIN_CREATE_PASSWORD: "throwaway-kc-password" };
    service = createRemoteHubService({
      startHelper: () =>
        HelperProcess.spawn(HELPER, (bin, args) => {
          const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env }) as unknown as ChildProcessWithoutNullStreams;
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
          return child;
        }),
      env: {},
    });
  }, 180_000);

  afterAll(() => {
    clearTimeout(watchdog);
    service?.stop();
    if (cid !== "") spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("a use-once open and a saved-credential open leave neither secret anywhere", async () => {
    const profiles = new ProfileBook({ store: new MemoryProfiles(), now: () => new Date(), newId: () => randomUUID() });
    const meta = new MemoryMeta();
    const book = new CredentialBook({ store: meta, vault: service.credentialVault, profiles, now: () => new Date(), newId: () => randomUUID() });
    const profile = profiles.save({
      fields: {
        name: "xrdp",
        protocol: "rdp",
        group: null,
        tags: [],
        favorite: false,
        color: null,
        host: "127.0.0.1",
        port,
        username: "rdptest",
        domain: null,
        authType: "password",
        identityFile: null,
        credentialRef: null,
        rdpWidth: null,
        rdpHeight: null,
      },
    });
    const { ref } = await book.save({ profileId: profile.id, secret: SAVED });
    expect(await book.status(ref)).toBe("present");

    // 1. A typed password (use once).
    const once = await service.rdpOpen({ host: "127.0.0.1", port, username: "rdptest", password: TYPED }, 800, 600, profile.id);
    const prompt = await poll(() => service.rdpInfo(once)?.prompt, 30_000, "certificate prompt");
    await service.rdpCertDecision(once, prompt.fingerprint, "session_trust");
    await poll(() => service.rdpInfo(once)?.state === "desktop_ready", 30_000, "desktop_ready (typed password)");

    // 2. The saved credential: the page names the reference; the helper resolves it from the Keychain.
    book.authorizeEndpoint(ref, { protocol: "rdp", host: "127.0.0.1", port, user: "rdptest", domain: null });
    const saved = await service.rdpOpen({ host: "127.0.0.1", port, username: "rdptest", credentialRef: ref }, 800, 600, profile.id);
    await poll(() => service.rdpInfo(saved)?.state === "desktop_ready", 30_000, "desktop_ready (saved credential)");

    // 3. A credential refused for another endpoint produces an error text, which is also searched.
    let refusal = "";
    try {
      book.authorizeEndpoint(ref, { protocol: "rdp", host: "evil.example.test", port, user: "rdptest", domain: null });
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      refusal = String((error as Error).message) + String((error as Error).stack);
    }
    expect(refusal).toContain("different host");

    // Search every channel.
    const processes = ourProcesses();
    expect(processes.length).toBeGreaterThanOrEqual(2); // the helper and at least one engine
    const channels: Record<string, string> = {
      "helper stderr": stderr,
      "session list": JSON.stringify(service.sessionList()),
      "credential list": JSON.stringify(book.list()),
      "profile rows": JSON.stringify(profiles.list()),
      "metadata rows": JSON.stringify([...meta.rows.values()]),
      "refusal text": refusal,
      "process arguments": processes.map(([, argv]) => argv).join("\n"),
      "process environments": processes.map(([pid]) => environmentText(pid)).join("\n"),
    };
    for (const [name, text] of Object.entries(channels)) {
      expect(text.includes(TYPED), `the typed password is in: ${name}`).toBe(false);
      expect(text.includes(SAVED), `the saved password is in: ${name}`).toBe(false);
    }
  }, 150_000);
});
