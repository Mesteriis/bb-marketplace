import { describe, expect, it } from "vitest";
import {
  SshArgError,
  assertSshOptionAllowed,
  buildSshArgv,
  buildSshSpawn,
  sshEnvAllowlist,
} from "./ssh-args.ts";

describe("buildSshArgv", () => {
  it("emits the minimal argv", () => {
    expect(buildSshArgv({ host: "example.com", extraOptions: [] })).toEqual([
      "ssh",
      "-tt",
      "--",
      "example.com",
    ]);
  });

  it("places user and port as separate options", () => {
    expect(
      buildSshArgv({ host: "example.com", user: "alice", port: 2222, extraOptions: [] }),
    ).toEqual(["ssh", "-tt", "-l", "alice", "-p", "2222", "--", "example.com"]);
  });

  it("emits config, known_hosts and identity options", () => {
    expect(
      buildSshArgv({
        host: "example.com",
        configFile: "/tmp/ssh-config",
        knownHostsFile: "/tmp/known_hosts",
        identityFile: "/tmp/id_ed25519",
        extraOptions: [],
      }),
    ).toEqual([
      "ssh",
      "-tt",
      "-F",
      "/tmp/ssh-config",
      "-o",
      "UserKnownHostsFile=/tmp/known_hosts",
      "-i",
      "/tmp/id_ed25519",
      "-o",
      "IdentitiesOnly=yes",
      "--",
      "example.com",
    ]);
  });

  it("rejects a host starting with -", () => {
    expect(() => buildSshArgv({ host: "-oProxyCommand=evil", extraOptions: [] })).toThrow(SshArgError);
  });

  it("rejects a host with shell metacharacters", () => {
    expect(() => buildSshArgv({ host: "host; rm -rf /", extraOptions: [] })).toThrow(SshArgError);
  });

  it("rejects an out-of-range port", () => {
    try {
      buildSshArgv({ host: "h", port: 70000, extraOptions: [] });
      throw new Error("expected throw");
    } catch (error) {
      expect((error as SshArgError).code).toBe("invalid_port");
    }
  });
});

describe("assertSshOptionAllowed", () => {
  const forbidden = [
    "StrictHostKeyChecking=no",
    "UserKnownHostsFile=/dev/null",
    "-A",
    "-L",
    "-R",
    "-D",
    "-X",
    "-Y",
    "LocalCommand=echo hi",
    "ProxyCommand=nc %h %p",
  ];
  it.each(forbidden)("rejects %s", (option) => {
    expect(() => assertSshOptionAllowed(option)).toThrow(SshArgError);
    try {
      assertSshOptionAllowed(option);
    } catch (error) {
      expect((error as SshArgError).code).toBe("ssh_option_rejected");
    }
  });

  it("rejects any -o outside the allowlist", () => {
    expect(() => assertSshOptionAllowed("-o StrictHostKeyChecking=yes")).toThrow(SshArgError);
  });
});

describe("sshEnvAllowlist", () => {
  it("keeps only the allowlist", () => {
    const env = sshEnvAllowlist({
      TERM: "xterm",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      HOME: "/home/a",
      USER: "a",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      SECRET: "nope",
      AWS_KEY: "nope",
    });
    expect(env).toEqual({
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      HOME: "/home/a",
      USER: "a",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
    });
  });
});

describe("buildSshSpawn", () => {
  it("returns /usr/bin/ssh with the allowlisted env", () => {
    const spec = buildSshSpawn({ host: "example.com", extraOptions: [] }, { TERM: "xterm" });
    expect(spec.program).toBe("/usr/bin/ssh");
    expect(spec.argv).toEqual(["ssh", "-tt", "--", "example.com"]);
    expect(spec.env.TERM).toBe("xterm-256color");
    expect(spec.env.SECRET).toBeUndefined();
  });
});
