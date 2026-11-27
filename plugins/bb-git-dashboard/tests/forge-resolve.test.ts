import test from "node:test";
import assert from "node:assert/strict";
import { forgeResolver, type ForgeKind, type ResolverPorts } from "../src/core/forge/resolve.ts";
import { parseRemote } from "../src/core/forge/remote-url.ts";

const day = 86_400_000;
type Probe = "gitea" | "gitlab" | null | "unreachable";

function setup(options: {aliases?: Record<string, string>; probes?: Record<string, Probe>; now?: number} = {}) {
  const calls = {probe: [] as string[], ssh: [] as string[]};
  const store = new Map<string, {kind: ForgeKind | null; checkedAt: number}>();
  let now = options.now ?? 100 * day;
  const ports: ResolverPorts = {
    async sshHostname(alias) { calls.ssh.push(alias); return options.aliases?.[alias] ?? alias; },
    async probe(origin) { calls.probe.push(origin); return options.probes?.[origin] ?? null; },
    cache: {get: async host => store.get(host), set: async (host, value) => { store.set(host, value); }},
    now: () => now,
  };
  // A second resolver over the same ports behaves like the plugin after a reload.
  return {resolver: forgeResolver(ports), reloaded: () => forgeResolver(ports), calls, store, advance(ms: number) { now += ms; }};
}
const remote = (value: string) => parseRemote(value)!;

test("an SSH alias resolves through ssh -G to a well-known forge without probing", async () => {
  const {resolver, calls} = setup({aliases: {"github-work-alias": "github.com"}});
  assert.deepEqual(await resolver.resolve(remote("git@github-work-alias:Org/r.git")),
    {kind: "github", origin: "https://github.com", host: "github.com", status: "known"});
  assert.deepEqual(calls.probe, []);
});

test("Azure SSH and visualstudio.com hosts map to dev.azure.com", async () => {
  const {resolver} = setup();
  assert.deepEqual(await resolver.resolve(remote("git@ssh.dev.azure.com:v3/org/p/r")),
    {kind: "azure", origin: "https://dev.azure.com", host: "ssh.dev.azure.com", status: "known"});
  assert.equal((await resolver.resolve(remote("https://org.visualstudio.com/p/_git/r"))).kind, "azure");
});

test("an unknown host is probed once and then served from the cache", async () => {
  const {resolver, calls} = setup({probes: {"https://git.example.org": "gitea"}});
  assert.deepEqual(await resolver.resolve(remote("https://git.example.org/g/r.git")),
    {kind: "gitea", origin: "https://git.example.org", host: "git.example.org", status: "probed"});
  assert.equal((await resolver.resolve(remote("git@git.example.org:g/other.git"))).status, "cached");
  assert.deepEqual(calls.probe, ["https://git.example.org"]);
});

test("parallel lookups of one host share a single probe", async () => {
  const {resolver, calls} = setup({probes: {"https://git2.example.org": "gitea"}});
  const results = await Promise.all([1, 2, 3].map(() => resolver.resolve(remote("https://git2.example.org/a/b"))));
  assert.deepEqual(results.map(result => result.kind), ["gitea", "gitea", "gitea"]);
  assert.equal(calls.probe.length, 1);
});

test("a found forge is cached for 30 days, an unknown host for one day", async () => {
  const found = setup({probes: {"https://git.example.org": "gitlab"}});
  await found.resolver.resolve(remote("https://git.example.org/a/b"));
  found.advance(29 * day);
  assert.equal((await found.reloaded().resolve(remote("https://git.example.org/a/b"))).status, "cached");

  const unknown = setup();
  await unknown.resolver.resolve(remote("https://plain.example.org/a/b"));
  unknown.advance(2 * day);
  await unknown.reloaded().resolve(remote("https://plain.example.org/a/b"));
  assert.equal(unknown.calls.probe.length, 2);
});

test("an unreachable host is reported and rechecked on request", async () => {
  const {resolver, calls} = setup({probes: {"https://gitlab.example.net": "unreachable"}});
  assert.deepEqual(await resolver.resolve(remote("git@gitlab.example.net:team/app.git")),
    {kind: "gitlab", origin: "https://gitlab.example.net", host: "gitlab.example.net", status: "unreachable"});
  // The cached answer still says the server did not answer, without probing again.
  assert.equal((await resolver.resolve(remote("git@gitlab.example.net:team/app.git"))).status, "unreachable");
  assert.equal(calls.probe.length, 1);
  await resolver.resolve(remote("git@gitlab.example.net:team/app.git"), {recheck: true});
  assert.equal(calls.probe.length, 2);
});

test("an SSH alias without a configured hostname stays unknown and is not probed", async () => {
  const {resolver, calls} = setup();
  assert.deepEqual(await resolver.resolve(remote("git@work-box:team/app.git")),
    {kind: null, origin: null, host: "work-box", status: "unknown"});
  assert.deepEqual(calls.probe, []);
});

test("an unreachable server keeps no kind unless its name says GitLab", async () => {
  const {resolver} = setup({probes: {"https://git.offline.example": "unreachable", "https://gitlab.offline.example": null}});
  assert.equal((await resolver.resolve(remote("https://git.offline.example/a/b"))).kind, null);
  // A reachable server that answers neither probe is not called GitLab because of its name.
  assert.equal((await resolver.resolve(remote("https://gitlab.offline.example/a/b"))).kind, null);
});
