import { describe, expect, it } from "vitest";
import { parseSshConfig, patternMatches, type ConfigOptions } from "./ssh-config.ts";

const opts = (files: Record<string, string> = {}): ConfigOptions => ({
  home: "/home/fixture",
  include: (pattern) => Object.entries(files).filter(([path]) => path === pattern).map(([path, text]) => ({ path, text })),
});

describe("parseSshConfig", () => {
  it("reads an alias with HostName, Port, User and IdentityFile (~ expanded), and nothing else", () => {
    const parse = parseSshConfig(
      `# a comment
Host build
  HostName build.example.test
  Port 2222
  User ci
  IdentityFile ~/.ssh/id_build
  ForwardAgent yes
`,
      opts(),
    );
    expect(parse.entries).toEqual([
      { alias: "build", hostName: "build.example.test", port: 2222, user: "ci", identityFiles: ["/home/fixture/.ssh/id_build"], flags: [], line: 2 },
    ]);
  });

  it("accepts Key=value, quoted values and several aliases on one Host line", () => {
    const parse = parseSshConfig('Host "a" b\n  User="quoted user"\n  Port = 22\n', opts());
    expect(parse.entries.map((e) => [e.alias, e.user, e.port])).toEqual([["a", "quoted user", 22], ["b", "quoted user", 22]]);
  });

  it("first value wins across blocks in file order, wildcard blocks included; later values never override", () => {
    const parse = parseSshConfig(
      `Host web
  User deploy
Host *
  User fallback
  Port 2200
Host web
  Port 9999
`,
      opts(),
    );
    expect(parse.entries).toHaveLength(1);
    expect(parse.entries[0]).toMatchObject({ alias: "web", user: "deploy", port: 2200 });
    expect(parse.patternBlocks).toBe(1);
  });

  it("negated patterns exclude, ? and * match, case does not matter", () => {
    expect(patternMatches("*.Example.test", "build.example.TEST")).toBe(true);
    expect(patternMatches("h?st", "host")).toBe(true);
    expect(patternMatches("h?st", "hoost")).toBe(false);
    const parse = parseSshConfig("Host a b\nHost * !b\n  User star\nHost a b\n  User ab\n", opts());
    expect(parse.entries.find((e) => e.alias === "a")?.user).toBe("star");
    expect(parse.entries.find((e) => e.alias === "b")?.user).toBe("ab");
  });

  it("%h in HostName is the alias; any other token flags the entry instead of being guessed", () => {
    const ok = parseSshConfig("Host t\n  HostName %h.example.test\n", opts());
    expect(ok.entries[0]).toMatchObject({ hostName: "t.example.test", flags: [] });
    const tokens = parseSshConfig("Host t\n  HostName %n.example.test\n  User %r\n", opts());
    expect(tokens.entries[0]?.flags).toEqual(["tokens"]);
  });

  it("ProxyJump, ProxyCommand, Match, canonicalization and HostKeyAlias are flagged, never resolved", () => {
    const proxy = parseSshConfig("Host j\n  ProxyJump bastion\nHost c\n  ProxyCommand nc %h %p\nHost n\n  ProxyJump none\n", opts());
    expect(proxy.entries.map((e) => [e.alias, e.flags])).toEqual([["j", ["proxy"]], ["c", ["proxy"]], ["n", []]]);
    const match = parseSshConfig("Host m\n  User a\nMatch host m exec \"true\"\n  User b\n", opts());
    expect(match.entries[0]).toMatchObject({ user: "a", flags: ["match"] });
    const other = parseSshConfig("Host k\n  CanonicalizeHostname yes\n  HostKeyAlias real\n", opts());
    expect(other.entries[0]?.flags).toEqual(["canonicalize", "host-key-alias"]);
  });

  it("an Include is followed through the callback (and only what it returns), a bad port is ignored", () => {
    const parse = parseSshConfig("Include conf.d/*\nHost a\n  Port 99999\n", opts({ "conf.d/*": "Host inc\n  User included\n" }));
    expect(parse.entries.map((e) => [e.alias, e.user, e.port])).toEqual([["inc", "included", null], ["a", null, null]]);
    const refused = parseSshConfig("Include /etc/elsewhere\nHost a\n", opts());
    expect(refused.entries.map((e) => e.alias)).toEqual(["a"]);
  });

  it("an Include nested too deeply is not followed and says so", () => {
    const loop = { loop: "Include loop\nHost x\n" };
    const parse = parseSshConfig("Include loop\n", { ...opts(loop), maxDepth: 3 });
    expect(parse.issues).toContain("an Include nested too deeply was not followed");
  });

  it("a Host line with only patterns makes no alias; text with no Host lines makes none", () => {
    expect(parseSshConfig("Host *\n  User x\nHost *.corp !bad.corp\n", opts()).entries).toEqual([]);
    expect(parseSshConfig("", opts()).entries).toEqual([]);
    expect(parseSshConfig("garbage line without keyword structure\n=\n", opts()).entries).toEqual([]);
  });
});
