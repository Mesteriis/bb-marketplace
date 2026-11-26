import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { originOf } from "../../core/inventory";
import { BridgeCli } from "./bridge-cli";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let dir: string;
let bb: string;

/** A fake `bb`: records its arguments, answers from a script body. */
async function fakeBb(body: string): Promise<void> {
  await writeFile(bb, `#!/bin/sh\necho "$@" >> "${dir}/calls"\n${body}\n`);
  await chmod(bb, 0o755);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-cli-"));
  bb = join(dir, "bb");
});

describe("BridgeCli", () => {
  it("parses real `list --json` output", async () => {
    await fakeBb(`cat ${fixture("list.json")}`);
    const plugins = await new BridgeCli(bb).list();
    expect(plugins).toHaveLength(7);
    expect(plugins.map((plugin) => originOf(plugin.sourceIntent, "/Users/test/mcp/data"))).toEqual([
      "catalog",
      "infra",
      "other",
      "other",
      "other",
      "other",
      "other",
    ]);
    expect(plugins[0]).toMatchObject({ name: "pkg-a", status: "active", lastError: null });
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("agent-plugins list --json\n");
  });

  it("parses real `show --json` output into mcpServers", async () => {
    await fakeBb(`cat ${fixture("show.json")}`);
    const { mcpServers } = await new BridgeCli(bb).show("46cae27e");
    expect(mcpServers.length).toBeGreaterThan(3);
    expect(mcpServers[0]).toMatchObject({ serverId: "srv-1", approved: 1, enabled: 1 });
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("agent-plugins show 46cae27e --json\n");
  });

  it("turns a non-zero exit into an Error carrying stderr", async () => {
    await fakeBb(`echo "плагин не найден" >&2; exit 1`);
    await expect(new BridgeCli(bb).show("x")).rejects.toThrow("плагин не найден");
  });

  it("passes only the tail of a long stderr and never an env value", async () => {
    await fakeBb(`i=1; while [ $i -le 60 ]; do echo "noise $i token=$BB_TEST_TOKEN" >&2; i=$((i+1)); done; echo "real reason" >&2; exit 1`);
    const cli = new BridgeCli(bb, { ...process.env, BB_TEST_TOKEN: "s3cr3t-value" });
    const error = await cli.show("x").then(() => null, (e: Error) => e);
    const lines = (error?.message ?? "").split("\n");
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe("real reason");
    expect(error?.message).not.toContain("s3cr3t-value");
    expect(error?.message).toContain("token=***");
  });

  it("reports a missing binary", async () => {
    await expect(new BridgeCli(join(dir, "nope")).list()).rejects.toThrow();
  });

  it("issues the documented commands", async () => {
    await fakeBb(`echo '{"id":"p1"}'`);
    const cli = new BridgeCli(bb);
    expect(await cli.install("/pkg/dir")).toEqual({ id: "p1" });
    await cli.update("p1");
    await cli.remove("p1");
    await cli.approve("p1", "s1");
    await cli.setEnabled("p1", "s1", true);
    await cli.setEnabled("p1", "s1", false);
    await cli.auth("p1", "s1");
    expect((await readFile(join(dir, "calls"), "utf8")).trim().split("\n")).toEqual([
      "agent-plugins install /pkg/dir --json",
      "agent-plugins update p1 --json",
      "agent-plugins remove p1 --json",
      "agent-plugins approve p1 s1 --json",
      "agent-plugins enable p1 s1 --json",
      "agent-plugins disable p1 s1 --json",
      "agent-plugins auth p1 s1 --json",
    ]);
  });

  it("reads the plugin id of install from a nested plugin object and the auth url", async () => {
    await fakeBb(`echo '{"plugin":{"id":"p2"},"url":"https://x.test/auth"}'`);
    const cli = new BridgeCli(bb);
    expect(await cli.install("/d")).toEqual({ id: "p2" });
    expect(await cli.auth("p2", "s")).toEqual({ url: "https://x.test/auth" });
  });

  it("rejects an install answer without an id", async () => {
    await fakeBb(`echo '{}'`);
    await expect(new BridgeCli(bb).install("/d")).rejects.toThrow();
  });

  it("does not count the error pseudo-tool a failed server shows, and reads a plugin id that contains underscores", async () => {
    await fakeBb(
      `echo '${JSON.stringify({ tools: [
        { opaqueId: "p__x__s__error_1", pluginName: "n", serverId: "s", name: "__error_s", status: "error" },
        { opaqueId: "p__x__s__t_1", pluginName: "n", serverId: "s", name: "t", status: "ready" },
      ] })}'`,
    );
    expect(await new BridgeCli(bb).toolCounts([{ pluginId: "p__x", serverId: "s" }])).toEqual({ counts: { "p__x/s": 1 }, skipped: 0 });
  });

  it("counts tools per plugin and server across pages of 200", async () => {
    const page = (n: number, pluginId: string, serverId: string) =>
      JSON.stringify({ tools: Array.from({ length: n }, (_, i) => ({ opaqueId: `${pluginId}__${serverId}__t${i}_abc123`, pluginName: `mcp-${serverId}`, serverId, name: `t${i}`, status: "ready" })) });
    await fakeBb(
      [
        `case "$*" in`,
        `  *"--offset 0"*) echo '${page(200, "p1", "a")}';;`,
        `  *"--offset 200"*) echo '${page(3, "p2", "b")}';;`,
        `  *) echo '{"tools":[]}';;`,
        `esac`,
      ].join("\n"),
    );
    expect(await new BridgeCli(bb).toolCounts([{ pluginId: "p1", serverId: "a" }, { pluginId: "p2", serverId: "b" }])).toEqual({ counts: { "p1/a": 200, "p2/b": 3 }, skipped: 0 });
    expect((await readFile(join(dir, "calls"), "utf8")).split("\n").filter(Boolean)).toEqual([
      "agent-plugins tools --limit 200 --offset 0 --json",
      "agent-plugins tools --limit 200 --offset 200 --json",
    ]);
  });

  it("counts a tool for the known row whose prefix and server id match, not for a colliding one", async () => {
    await fakeBb(
      `echo '${JSON.stringify({ tools: [
        { opaqueId: "p__a__b__t_1", pluginName: "n", serverId: "b", name: "t", status: "ready" },
        { opaqueId: "p__a__u_1", pluginName: "n", serverId: "a", name: "u", status: "ready" },
        { opaqueId: "zz__q__v_1", pluginName: "n", serverId: "q", name: "v", status: "ready" },
      ] })}'`,
    );
    const known = [{ pluginId: "p", serverId: "a" }, { pluginId: "p__a", serverId: "b" }];
    expect(await new BridgeCli(bb).toolCounts(known)).toEqual({ counts: { "p/a": 1, "p__a/b": 1 }, skipped: 1 });
  });

  it("does not guess when a plugin id containing `__<serverId>__` makes an opaqueId ambiguous", async () => {
    await fakeBb(
      `echo '${JSON.stringify({ tools: [
        { opaqueId: "p__s__x__s__t_1", pluginName: "n", serverId: "s", name: "t", status: "ready" },
        { opaqueId: "p__s__u_1", pluginName: "n", serverId: "s", name: "u", status: "ready" },
        { opaqueId: "p__s__x__s__v_1", pluginName: "n", serverId: "s", name: "v", status: "ready" },
      ] })}'`,
    );
    const known = [{ pluginId: "p", serverId: "s" }, { pluginId: "p__s__x", serverId: "s" }];
    expect(await new BridgeCli(bb).toolCounts(known)).toEqual({ counts: { "p/s": 1 }, skipped: 2 });
  });

  it("counts malformed rows and tools of unknown servers as skipped instead of dropping them silently", async () => {
    await fakeBb(
      `echo '${JSON.stringify({ tools: [
        { opaqueId: "p__s__t_1", pluginName: "n", serverId: "s", name: "t", status: "ready" },
        { serverId: "s", name: "no opaque id" },
        "not an object",
        { opaqueId: "gone__s__t_1", pluginName: "n", serverId: "s", name: "t", status: "ready" },
        { opaqueId: "p__s__error_1", pluginName: "n", serverId: "s", name: "__error_s", status: "error" },
      ] })}'`,
    );
    expect(await new BridgeCli(bb).toolCounts([{ pluginId: "p", serverId: "s" }])).toEqual({ counts: { "p/s": 1 }, skipped: 3 });
  });
});
