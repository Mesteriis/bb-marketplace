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
    expect(await new BridgeCli(bb).toolCounts([{ pluginId: "p__x", serverId: "s" }])).toEqual({ "p__x/s": 1 });
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
    expect(await new BridgeCli(bb).toolCounts([{ pluginId: "p1", serverId: "a" }, { pluginId: "p2", serverId: "b" }])).toEqual({ "p1/a": 200, "p2/b": 3 });
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
    expect(await new BridgeCli(bb).toolCounts(known)).toEqual({ "p/a": 1, "p__a/b": 1 });
  });
});
