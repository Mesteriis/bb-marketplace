import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentSocketFor, NO_USER_SSH_CONFIG, readUserSshConfig, type AgentResolution, type UserSshConfig } from "./user-ssh-agent.ts";

const HOME = "/Users/someone";
const env = { SSH_AUTH_SOCK: "/tmp/launchd/agent.sock", HOME };
const plain = (text: string): UserSshConfig => ({ ...NO_USER_SSH_CONFIG, text });
const at = (config: string | UserSshConfig, host = "box.test", e: Record<string, string | undefined> = env, home = HOME): AgentResolution =>
  agentSocketFor({ env: e, home, host, user: "me", uid: 501, config: typeof config === "string" ? plain(config) : config });
const sock = (path: string): AgentResolution => ({ kind: "socket", path });
const UNKNOWN: AgentResolution = { kind: "unknown" };

describe("which agent socket ssh uses for a host", () => {
  it("is SSH_AUTH_SOCK when the configuration names no IdentityAgent, and none without it", () => {
    expect(at("")).toEqual(sock("/tmp/launchd/agent.sock"));
    expect(at("Host other\n  IdentityAgent /x/y.sock\n")).toEqual(sock("/tmp/launchd/agent.sock"));
    expect(at("", "box.test", { HOME })).toEqual({ kind: "none" });
  });

  it("is the configured socket when a global or matching Host block names one, and the configuration wins over SSH_AUTH_SOCK", () => {
    expect(at("IdentityAgent /a/global.sock\n")).toEqual(sock("/a/global.sock"));
    expect(at("Host *.test\n  IdentityAgent /a/test.sock\n")).toEqual(sock("/a/test.sock"));
    expect(at("Host box.test other\n  identityagent=/a/eq.sock\n")).toEqual(sock("/a/eq.sock"));
    expect(at('Host *\n  IdentityAgent "~/Library/Group Containers/x y/agent.sock"\n')).toEqual(sock(`${HOME}/Library/Group Containers/x y/agent.sock`));
    expect(at("Host box.test\n  IdentityAgent /first.sock\nHost *\n  IdentityAgent /second.sock\n")).toEqual(sock("/first.sock"));
  });

  it("reads a Host line the way ssh does: a comment after # takes no part in the matching", () => {
    expect(at("Host box.test # !box.test\n  IdentityAgent /own.sock\n")).toEqual(sock("/own.sock"));
    expect(at("Host *.test !box.test\n  IdentityAgent /a.sock\n")).toEqual(sock("/tmp/launchd/agent.sock"));
    expect(at("Host bo?.test\n  IdentityAgent /a.sock\n")).toEqual(sock("/a.sock"));
  });

  it("honours none, SSH_AUTH_SOCK and a whole-variable value", () => {
    expect(at("IdentityAgent none\n")).toEqual({ kind: "none" });
    expect(at("IdentityAgent SSH_AUTH_SOCK\n")).toEqual(sock("/tmp/launchd/agent.sock"));
    expect(at("IdentityAgent $AGENT_SOCK\n", "box.test", { ...env, AGENT_SOCK: "/e/s.sock" })).toEqual(sock("/e/s.sock"));
    expect(at("IdentityAgent $NOPE\n")).toEqual(UNKNOWN);
  });

  it("expands variables, ~, %d %u %h %i %% inside a path", () => {
    const e = { ...env, RUNDIR: "/run/u", NAME: "agent" };
    expect(at("IdentityAgent ${RUNDIR}/${NAME}.sock\n", "box.test", e)).toEqual(sock("/run/u/agent.sock"));
    expect(at("IdentityAgent $RUNDIR/s.sock\n", "box.test", e)).toEqual(sock("/run/u/s.sock"));
    expect(at("IdentityAgent ~/.agent/s\n")).toEqual(sock("/Users/someone/.agent/s"));
    expect(at("IdentityAgent %d/.agent/s\n")).toEqual(sock("/Users/someone/.agent/s"));
    expect(at("IdentityAgent /run/%u/%i/a-%h.sock\n")).toEqual(sock("/run/me/501/a-box.test.sock"));
    expect(at("HostName real.example\nIdentityAgent /run/a-%h.sock\n")).toEqual(sock("/run/a-real.example.sock"));
    expect(at("IdentityAgent /run/100%%/a.sock\n")).toEqual(sock("/run/100%/a.sock"));
  });

  it("says unknown, not absent, for what the text cannot settle", () => {
    expect(at("IdentityAgent ~other/agent.sock\n")).toEqual(UNKNOWN);
    expect(at("IdentityAgent /run/%r/%p/a.sock\n")).toEqual(UNKNOWN);
    expect(at("IdentityAgent /run/%L/a.sock\n")).toEqual(UNKNOWN);
    expect(at("IdentityAgent ${NOPE}/a.sock\n")).toEqual(UNKNOWN);
    expect(at("IdentityAgent relative/agent.sock\n")).toEqual(UNKNOWN);
    expect(at("Match host box.test\n  IdentityAgent /a.sock\n")).toEqual(UNKNOWN);
    expect(at("Match all\n  IdentityAgent /m.sock\nHost box.test\n  IdentityAgent /h.sock\n")).toEqual(UNKNOWN);
    expect(at("Host box.test\n  IdentityAgent /h.sock\nMatch all\n  IdentityAgent /m.sock\n")).toEqual(sock("/h.sock"));
    expect(at({ ...NO_USER_SSH_CONFIG, text: "IdentityAgent /a.sock\n", truncated: true })).toEqual(UNKNOWN);
  });
});

describe("Include in the owner's configuration", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A home directory in the temporary directory, with ~/.ssh/<name> files. */
  function home(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "rh-agent-"));
    made.push(dir);
    mkdirSync(join(dir, ".ssh", "conf.d"), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, ".ssh", name), text);
    return dir;
  }
  const resolve = (dir: string, host = "box.test"): AgentResolution => {
    const config = readUserSshConfig(dir);
    return config === null ? UNKNOWN : at(config, host, env, dir);
  };

  it("finds an IdentityAgent in conf.d/*.conf, by a path relative to ~/.ssh, ~ or an absolute one", () => {
    const relative = home({ config: "Include conf.d/*.conf\n", "conf.d/a.conf": "IdentityAgent /inc/a.sock\n" });
    expect(resolve(relative)).toEqual(sock("/inc/a.sock"));
    const tilde = home({ config: "Include ~/.ssh/conf.d/*.conf\n", "conf.d/a.conf": "IdentityAgent /inc/t.sock\n" });
    expect(resolve(tilde)).toEqual(sock("/inc/t.sock"));
    const abs = home({ "conf.d/a.conf": "IdentityAgent /inc/x.sock\n" });
    writeFileSync(join(abs, ".ssh", "config"), `Include ${join(abs, ".ssh", "conf.d", "a.conf")}\n`);
    expect(resolve(abs)).toEqual(sock("/inc/x.sock"));
  });

  it("expands an Include where its line stands: lines before it win, lines after it come later", () => {
    const before = home({ config: "IdentityAgent /own/first.sock\nInclude conf.d/*.conf\n", "conf.d/a.conf": "IdentityAgent /inc/a.sock\n" });
    expect(resolve(before)).toEqual(sock("/own/first.sock"));
    const after = home({ config: "Include conf.d/*.conf\nIdentityAgent /own/last.sock\n", "conf.d/a.conf": "IdentityAgent /inc/a.sock\n" });
    expect(resolve(after)).toEqual(sock("/inc/a.sock"));
    const order = home({ config: "Include conf.d/*.conf\n", "conf.d/b.conf": "IdentityAgent /inc/b.sock\n", "conf.d/a.conf": "IdentityAgent /inc/a.sock\n" });
    expect(resolve(order)).toEqual(sock("/inc/a.sock"));
  });

  it("applies an Include inside a Host block only to the hosts that block selects", () => {
    const dir = home({ config: "Host box.test\n  Include conf.d/box.conf\nHost other\n  Include conf.d/other.conf\n", "conf.d/box.conf": "IdentityAgent /inc/box.sock\n", "conf.d/other.conf": "IdentityAgent /inc/other.sock\n" });
    expect(resolve(dir, "box.test")).toEqual(sock("/inc/box.sock"));
    expect(resolve(dir, "other")).toEqual(sock("/inc/other.sock"));
    expect(resolve(dir, "elsewhere")).toEqual(sock("/tmp/launchd/agent.sock"));
  });

  it("does not follow a cycle, a link out of ~/.ssh, or more files than the budget; each is unknown", () => {
    const cycle = home({ config: "Include config\n" });
    expect(resolve(cycle)).toEqual(UNKNOWN);
    const loop = home({ config: "Include conf.d/*.conf\n", "conf.d/a.conf": "Include conf.d/b.conf\n", "conf.d/b.conf": "Include conf.d/a.conf\n" });
    expect(resolve(loop)).toEqual(UNKNOWN);
    const out = home({ config: "Include conf.d/*.conf\n" });
    const elsewhere = mkdtempSync(join(tmpdir(), "rh-agent-out-"));
    made.push(elsewhere);
    writeFileSync(join(elsewhere, "x.conf"), "IdentityAgent /out/x.sock\n");
    symlinkSync(join(elsewhere, "x.conf"), join(out, ".ssh", "conf.d", "x.conf"));
    expect(resolve(out)).toEqual(UNKNOWN);
    const many: Record<string, string> = { config: "Include conf.d/*.conf\n" };
    for (let i = 0; i < 70; i++) many[`conf.d/f${String(i).padStart(2, "0")}.conf`] = "# nothing\n";
    expect(resolve(home(many))).toEqual(UNKNOWN);
  });

  it("follows a chain of 16 nested Includes and refuses a 17th", () => {
    const chain = (length: number): Record<string, string> => {
      const files: Record<string, string> = { config: "Include conf.d/n1.conf\n" };
      for (let i = 1; i <= length; i++) files[`conf.d/n${i}.conf`] = i < length ? `Include conf.d/n${i + 1}.conf\n` : "IdentityAgent /deep/a.sock\n";
      return files;
    };
    expect(resolve(home(chain(16)))).toEqual(sock("/deep/a.sock"));
    expect(resolve(home(chain(17)))).toEqual(UNKNOWN);
  });

  it("reads the configuration once: %h still finds HostName after more than 32 included files", () => {
    const files: Record<string, string> = { config: "Include conf.d/*.conf\nIdentityAgent /run/a-%h.sock\n" };
    for (let i = 0; i < 33; i++) files[`conf.d/f${String(i).padStart(2, "0")}.conf`] = i === 32 ? "HostName real.example\n" : "# nothing\n";
    expect(resolve(home(files))).toEqual(sock("/run/a-real.example.sock"));
  });

  it("is no config at all when ~/.ssh/config is missing, and unknown when it cannot be read", () => {
    const empty = mkdtempSync(join(tmpdir(), "rh-agent-"));
    made.push(empty);
    expect(readUserSshConfig(empty)).toBe(NO_USER_SSH_CONFIG);
    const dir = home({});
    mkdirSync(join(dir, ".ssh", "config"));
    expect(readUserSshConfig(dir)).toBeNull();
  });
});
