// The passive reader against the real thing: for fixture configs (HOME is a temp directory, nothing of the user's is
// read), what parseSshConfig says for an alias must equal what `/usr/bin/ssh -G -F <fixture> -- <alias>` says.
// `ssh -G` does not connect; the fixtures contain no Match exec and no ProxyCommand.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSshConfig } from "../../core/ssh-config.ts";
import { createFsSourceReader } from "./fs-source-reader.ts";

const haveSsh = existsSync("/usr/bin/ssh");
let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rh-oracle-"));
  mkdirSync(join(home, ".ssh"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function sshG(config: string, alias: string): Map<string, string> {
  const r = spawnSync("/usr/bin/ssh", ["-G", "-F", config, "--", alias], { env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8", timeout: 10_000, cwd: home });
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const m = /^([a-z]+) (.*)$/.exec(line);
    if (m !== null && !out.has(m[1] as string)) out.set(m[1] as string, m[2] as string);
  }
  return out;
}

function readerFor(config: string) {
  const reader = createFsSourceReader({ home, env: {} });
  const budget = { files: 50, bytes: 1024 * 1024 };
  const read = reader.readText(config, 256 * 1024)!;
  return parseSshConfig(read.text, { home, include: (p) => reader.include(config, p, budget), truncated: read.truncated });
}

function compare(files: Record<string, string>, aliases: string[]): number {
  let checked = 0;
  for (const [name, text] of Object.entries(files)) writeFileSync(join(home, ".ssh", name), text);
  const config = join(home, ".ssh", "config");
  const parse = readerFor(config);
  expect(parse.incomplete, JSON.stringify(parse.issues)).toBe(false);
  for (const alias of aliases) {
    const real = sshG(config, alias);
    const mine = parse.entries.find((e) => e.alias.toLowerCase() === alias.toLowerCase());
    // The reader resolves the aliases a config NAMES; a name only a wildcard matches is not one of them.
    if (mine === undefined) continue;
    const hostName = mine.hostName ?? alias;
    expect(hostName.toLowerCase(), `${alias}: hostname`).toBe(real.get("hostname"));
    expect(String(mine.port ?? 22), `${alias}: port`).toBe(real.get("port"));
    if (mine.user !== null) expect(mine.user, `${alias}: user`).toBe(real.get("user"));
    checked += 1;
  }
  return checked;
}

describe.skipIf(!haveSsh)("the reader agrees with `ssh -G` on fixture configs", () => {
  it("an Include before values written after it (the reviewers' fixture)", () => {
    compare(
      { config: "Include extra.conf\nUser admin\nHostName 10.9.9.9\n", "extra.conf": "Host prod\n  User deploy\n  HostName 10.0.0.1\n  Port 2201\n" },
      ["prod", "other"],
    );
  });

  it("an Include after the values it would have set: the earlier lines win", () => {
    compare({ config: "Host prod\n  HostName first.example\n  User first\nInclude extra.conf\n", "extra.conf": "Host prod\n  User second\n  HostName second.example\n  Port 2222\n" }, ["prod"]);
  });

  it("an Include inside a Host block applies only to that alias, with its own Host lines inside", () => {
    compare(
      { config: "Host a\n  Include inner.conf\n  HostName a-late\nHost b\n  HostName b.example\nHost leak\n  Port 4444\n", "inner.conf": "User fromextra\nHost leak\n  Port 3333\n" },
      ["a", "b", "leak"],
    );
  });

  it("wildcard blocks, Host *, negation and several patterns on one line, in file order", () => {
    compare(
      {
        config: [
          "Host web db",
          "  Port 2200",
          "Host *.corp !skip.corp",
          "  User corpuser",
          "  HostName %h.internal.invalid",
          "Host skip.corp",
          "  HostName skip.example",
          "Host *",
          "  Port 2300",
          "  User everyone",
          "Host web",
          "  Port 9999",
        ].join("\n"),
      },
      ["web", "db", "a.corp", "skip.corp", "zzz"],
    );
  });

  it("keywords in any case, = syntax, quotes, and a first value that a later one must not replace", () => {
    expect(compare({ config: 'host cased\n  HOSTNAME=case.example\n  port = 2022\nHost cased\n  Port 1\n  HostName "late.example"\nHost q\n  HostName "quoted.example"\n' }, ["cased", "q"])).toBe(2);
  });

  it("Host patterns are case-sensitive on the name as typed, exactly as in ssh", () => {
    writeFileSync(join(home, ".ssh", "config"), "Host Cased\n  HostName cased.example\n");
    const config = join(home, ".ssh", "config");
    expect(sshG(config, "Cased").get("hostname")).toBe("cased.example");
    expect(sshG(config, "cased").get("hostname")).toBe("cased");
    const entry = readerFor(config).entries[0];
    expect(entry).toMatchObject({ alias: "Cased", hostName: "cased.example", flags: [] });
  });

  it("%h in HostName, and %% staying a percent sign", () => {
    compare({ config: "Host tpl\n  HostName %h.example\nHost pct\n  HostName a%%b.example\n" }, ["tpl", "pct"]);
  });
});
