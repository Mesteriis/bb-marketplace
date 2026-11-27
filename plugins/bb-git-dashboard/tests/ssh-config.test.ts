import test from "node:test";
import assert from "node:assert/strict";
import { sshHostname } from "../src/adapters/bb/ssh-config.ts";

const output = "user git\nhostname github.com\nport 22\nidentityfile ~/.ssh/id_office\nproxycommand none\n";

test("only the hostname is taken from ssh -G output", async () => {
  const calls: string[][] = [];
  const hostname = await sshHostname("github-office", async args => { calls.push(args); return output; });
  assert.equal(hostname, "github.com");
  assert.deepEqual(calls, [["-G", "--", "github-office"]]);
});

test("an alias that looks like an option or carries spaces is refused before ssh runs", async () => {
  for (const alias of ["-oProxyCommand=touch x", "a b", "", "a;b", "a/b"]) {
    await assert.rejects(sshHostname(alias, async () => { throw new Error("ssh must not run"); }), /INVALID_INPUT/, alias);
  }
});

test("missing or malformed hostname output is reported", async () => {
  await assert.rejects(sshHostname("box", async () => "user git\n"), /SSH_CONFIG_UNAVAILABLE/);
  await assert.rejects(sshHostname("box", async () => "hostname two words\n"), /SSH_CONFIG_UNAVAILABLE/);
  await assert.rejects(sshHostname("box", async () => { throw new Error("spawn failed"); }), /SSH_CONFIG_UNAVAILABLE/);
});
