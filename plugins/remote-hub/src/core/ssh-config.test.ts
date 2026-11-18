import { describe, expect, it } from "vitest";
import { parseSshConfig, patternMatches, type ConfigOptions } from "./ssh-config.ts";

const opts = (files: Record<string, string> = {}, over: Partial<ConfigOptions> = {}): ConfigOptions => ({
  home: "/home/fixture",
  include: (pattern) => ({ files: Object.entries(files).filter(([path]) => path === pattern).map(([path, text]) => ({ path, text })), complete: true }),
  ...over,
});

describe("single-value keywords (X2)", () => {
  const noInclude = { home: "/h", include: () => ({ files: [], complete: true }) };

  it("extra words after HostName, Port or User make the read incomplete: ssh refuses such a line, so nothing it says is trusted", () => {
    for (const line of ["HostName a.example b.example", "Port 22 23", "User one two"]) {
      const parse = parseSshConfig(`Host x\n  ${line}\n`, noInclude);
      expect(parse.incomplete, line).toBe(true);
      expect(parse.entries[0]?.flags, line).toContain("incomplete");
      expect(parse.issues.join(" "), line).toContain("more than one value");
    }
  });

  it("one quoted value with spaces, a trailing comment and the = form are still one value", () => {
    for (const line of ['HostName "a b.example"', "HostName a.example # note", "HostName=a.example", "Port = 22"]) {
      expect(parseSshConfig(`Host x\n  ${line}\n`, noInclude).incomplete, line).toBe(false);
    }
  });
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
      { alias: "build", hostName: "build.example.test", port: 2222, user: "ci", identityFiles: ["/home/fixture/.ssh/id_build"], flags: [] },
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
    expect(patternMatches("*.example.test", "build.example.test")).toBe(true);
    // Case-sensitive, as ssh is (it lowercases the host it connects to and compares with the pattern as written).
    expect(patternMatches("*.Example.test", "build.example.test")).toBe(false);
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
    // Nothing named by an Include that returns nothing: a plain, complete scan.
    const none = parseSshConfig("Include /etc/elsewhere\nHost a\n", opts());
    expect(none.entries.map((e) => e.alias)).toEqual(["a"]);
    expect(none.incomplete).toBe(false);
  });

  it("an Include nested too deeply is not followed and says so", () => {
    const files = { "one": "Include two\nHost x\n", "two": "Include three\n", "three": "Include four\n", "four": "Host deep\n" };
    const parse = parseSshConfig("Include one\n", { ...opts(files), maxDepth: 3 });
    expect(parse.issues).toContain("an Include nested too deeply was not followed");
    expect(parse.incomplete).toBe(true);
  });

  it("a Host line with only patterns makes no alias; text with no Host lines makes none", () => {
    expect(parseSshConfig("Host *\n  User x\nHost *.corp !bad.corp\n", opts()).entries).toEqual([]);
    expect(parseSshConfig("", opts()).entries).toEqual([]);
    expect(parseSshConfig("garbage line without keyword structure\n=\n", opts()).entries).toEqual([]);
  });

  it("Include order is file order: a value from an included block comes before a value written after the Include", () => {
    // The reviewers' fixture: included `Host prod` sets deploy/10.0.0.1; the main file sets admin/10.9.9.9 after the Include.
    const parse = parseSshConfig("Include extra.conf\nUser admin\nHostName 10.9.9.9\n", opts({ "extra.conf": "Host prod\n  User deploy\n  HostName 10.0.0.1\n" }));
    expect(parse.entries.find((e) => e.alias === "prod")).toMatchObject({ user: "deploy", hostName: "10.0.0.1", flags: [] });
  });

  it("what an included file does stays inside it: its Host line does not change the scope of the lines after the Include", () => {
    const parse = parseSshConfig("Include extra.conf\nUser late\nHost other\n  Port 2200\n", opts({ "extra.conf": "Host x\n  User xu\n" }));
    expect(parse.entries.find((e) => e.alias === "x")).toMatchObject({ user: "xu" });
    // OpenSSH (verified with ssh -G): the global `User late` applies to every other alias, and `other` keeps its port.
    expect(parse.entries.find((e) => e.alias === "other")).toMatchObject({ user: "late", port: 2200 });
  });

  it("an Include inside a Host block applies only to that alias, and its own Host lines add to the condition", () => {
    const parse = parseSshConfig("Host a\n  Include inner.conf\n  HostName a-late\nHost b\n  HostName b.example\n", opts({ "inner.conf": "User fromextra\nHost leak\n  Port 3333\n" }));
    const by = (alias: string) => parse.entries.find((e) => e.alias === alias);
    expect(by("a")).toMatchObject({ user: "fromextra", hostName: "a-late", port: null });
    expect(by("b")).toMatchObject({ user: null, hostName: "b.example" });
    // `leak` is named only inside a block that `leak` does not select, so it is not an alias at all.
    expect(by("leak")).toBeUndefined();
  });

  it("an Include that was refused, over budget, unreadable, cyclic or cut makes EVERY entry incomplete (never resolved)", () => {
    const refused = parseSshConfig("Include conf.d/*\nHost a\n", opts({}, { include: () => ({ files: [], complete: false }) }));
    expect(refused.incomplete).toBe(true);
    expect(refused.entries[0]?.flags).toEqual(["incomplete"]);
    const cyc = parseSshConfig("Include a\nHost z\n", opts({ a: "Include a\nHost y\n" }));
    expect(cyc.incomplete).toBe(true);
    expect(cyc.issues).toContain("an Include cycle was not followed");
    const cut = parseSshConfig("Include big\nHost a\n", { ...opts(), include: () => ({ files: [{ path: "big", text: "Host b\n", truncated: true }], complete: true }) });
    expect(cut.incomplete).toBe(true);
    const truncatedMain = parseSshConfig("Host a\n", { ...opts(), truncated: true });
    expect(truncatedMain.entries[0]?.flags).toEqual(["incomplete"]);
    const vars = parseSshConfig("Include ${HOME}/x\nHost a\n", opts());
    expect(vars.incomplete).toBe(true);
    // A missing include with no match is not a problem: ssh ignores it too.
    expect(parseSshConfig("Include nothing\nHost a\n", opts()).incomplete).toBe(false);
  });

  it("%%h is the text %h, not the alias", () => {
    expect(parseSshConfig("Host t\n  HostName x%%h.example\n", opts()).entries[0]).toMatchObject({ hostName: "x%h.example", flags: [] });
    expect(parseSshConfig("Host t\n  HostName %%%h.example\n", opts()).entries[0]).toMatchObject({ hostName: "%t.example" });
  });
});
