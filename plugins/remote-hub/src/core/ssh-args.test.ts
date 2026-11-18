import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SshArgError,
  assertSshOptionAllowed,
  buildSshArgv,
  buildSshExecSpawn,
  buildSshSpawn,
  sshEnvAllowlist,
  type SshTarget,
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

describe("ssh-args shared fixture (asserted by both TS and Rust)", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../../tests/fixtures/ssh-args.json", import.meta.url), "utf8"),
  ) as { cases: Array<{ name: string; target: SshTarget; argv: string[]; error: string | null }> };

  it.each(fixture.cases)("$name", (c) => {
    if (c.error === null) {
      expect(buildSshArgv(c.target)).toEqual(c.argv);
    } else {
      try {
        buildSshArgv(c.target);
        throw new Error("expected buildSshArgv to throw");
      } catch (error) {
        expect((error as SshArgError).code).toBe(c.error);
      }
    }
  });
});

describe("authMethod (set by the server when a saved secret is used)", () => {
  const base = { host: "h.test", extraOptions: [] as string[] };
  it("emits exactly one PreferredAuthentications for each method", () => {
    expect(buildSshArgv({ ...base, authMethod: "password" })).toContain("PreferredAuthentications=password");
    expect(buildSshArgv({ ...base, authMethod: "publickey" })).toContain("PreferredAuthentications=publickey");
    expect(buildSshArgv(base).some((a) => a.startsWith("PreferredAuthentications"))).toBe(false);
  });
  it("a saved secret: NumberOfPasswordPrompts=2 goes with it (the second prompt is how a refusal is noticed), and never without", () => {
    expect(buildSshArgv({ ...base, authMethod: "password" })).toContain("NumberOfPasswordPrompts=2");
    expect(buildSshArgv({ ...base, authMethod: "publickey" })).toContain("NumberOfPasswordPrompts=2");
    expect(buildSshArgv(base).some((a) => a.startsWith("NumberOfPasswordPrompts"))).toBe(false);
  });
  it("a saved-secret session reads no SSH configuration: -F none replaces any configFile, and a key has no agent", () => {
    const withCfg = buildSshArgv({ ...base, configFile: "/Users/x/.ssh/config", authMethod: "password", user: "root" });
    expect(withCfg).toContain("none");
    expect(withCfg[withCfg.indexOf("-F") + 1]).toBe("none");
    expect(withCfg).not.toContain("/Users/x/.ssh/config");
    const key = buildSshArgv({ ...base, authMethod: "publickey", identityFile: "/k/id" });
    expect(key).toContain("IdentityAgent=none");
    expect(key).toContain("IdentitiesOnly=yes");
    expect(buildSshArgv({ ...base, authMethod: "password", user: "root" })).not.toContain("IdentityAgent=none");
    // Without a saved secret the configFile still works.
    expect(buildSshArgv({ ...base, configFile: "/tmp/c" })).toContain("/tmp/c");
  });
  it("a saved-secret session names the destination in lower case (the form it is bound to and prompted in)", () => {
    for (const host of ["BOX.Example.TEST", "10.0.0.7", "FE80::ABCD"]) {
      const argv = buildSshArgv({ host, extraOptions: [], authMethod: "password", user: "u" });
      expect(argv[argv.length - 1]).toBe(host.toLowerCase());
    }
    expect(buildSshArgv({ host: "BOX.Example.TEST", extraOptions: [] }).slice(-1)[0]).toBe("BOX.Example.TEST");
  });
  it("refuses another value", () => {
    expect(() => buildSshArgv({ ...base, authMethod: "none" as never })).toThrow(/authMethod/);
  });
});

describe("a host-key file with a saved secret (W8)", () => {
  const withSecret: SshTarget = { host: "box.example.test", user: "u", port: 22, authMethod: "password", knownHostsFile: "/tmp/kh", extraOptions: [] };

  it("is refused early and clearly: the helper's own file is the only one a saved-secret session reads", () => {
    expect(() => buildSshArgv(withSecret)).toThrowError(/knownHostsFile is not accepted/);
    expect(() => buildSshSpawn(withSecret, {})).toThrowError(SshArgError);
  });

  it("a session without a saved secret still takes it", () => {
    const { authMethod: _a, ...plain } = withSecret;
    void _a;
    expect(buildSshArgv(plain)).toContain("UserKnownHostsFile=/tmp/kh");
  });

  it("only a test-hooks setup lets the same field through", () => {
    expect(buildSshSpawn(withSecret, { REMOTE_HUB_TEST_ALLOW_KNOWN_HOSTS: "1" }).argv).toContain("UserKnownHostsFile=/tmp/kh");
  });
});

describe("buildSshExecSpawn: one remote command, no pty", () => {
  const target: SshTarget = { host: "Box.Example.Test", user: "ops", port: 2222, authMethod: "password", extraOptions: [] };

  it("is the session argv with -T instead of -tt and the command as ONE last word after the host", () => {
    const spec = buildSshExecSpawn(target, "ls -la /tmp; echo $HOME | wc -l", { PATH: "/usr/bin", HOME: "/h", SECRET_TOKEN: "x" });
    expect(spec.program).toBe("/usr/bin/ssh");
    expect(spec.argv).toEqual([
      "ssh", "-T", "-l", "ops", "-p", "2222", "-F", "none", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=2", "--", "box.example.test",
      "ls -la /tmp; echo $HOME | wc -l",
    ]);
    expect(spec.env).toEqual({ TERM: "xterm-256color", HOME: "/h", PATH: "/usr/bin" });
  });

  it("keeps the command byte for byte: no splitting, quoting or expansion is done here", () => {
    const tricky = "printf '%s\n' \"a b\" $(id) `id` > /tmp/x; echo 'it''s'";
    expect(buildSshExecSpawn(target, tricky, {}).argv.at(-1)).toBe(tricky);
  });

  it("refuses an empty command, one with a NUL, and one over 8192 UTF-8 bytes (a limit counted in bytes, not characters)", () => {
    expect(() => buildSshExecSpawn(target, "", {})).toThrow(SshArgError);
    expect(() => buildSshExecSpawn(target, "a\0b", {})).toThrow(SshArgError);
    expect(() => buildSshExecSpawn(target, "x".repeat(8193), {})).toThrow(SshArgError);
    expect(buildSshExecSpawn(target, "x".repeat(8192), {}).argv.at(-1)).toHaveLength(8192);
    expect(() => buildSshExecSpawn(target, "é".repeat(4097), {})).toThrow(SshArgError); // 8194 bytes
    expect(buildSshExecSpawn(target, "é".repeat(4096), {}).argv.at(-1)).toHaveLength(4096);
  });
});
