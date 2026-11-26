import { execFile } from "node:child_process";
import { z } from "zod";
import type { BridgePlugin, BridgePort, BridgeServer } from "../../core/inventory";

const Plugin = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  sourceIntent: z.string(),
  status: z.string(),
  lastError: z.string().nullable().default(null),
});

const Server = z.object({
  pluginId: z.string(),
  serverId: z.string(),
  type: z.string(),
  status: z.string(),
  lastError: z.string().nullable().default(null),
  approved: z.number(),
  enabled: z.number(),
});

const TOOLS_PAGE = 200;
// `bb agent-plugins tools --json` carries no plugin id field: it is the prefix of `opaqueId`
// (`<pluginId>__<serverId>__<tool>_<hash>`), matched against the rows the inventory knows. A failed server shows one pseudo-tool with status "error".
const ToolsOutput = z.object({
  tools: z.array(z.object({ opaqueId: z.string(), serverId: z.string(), status: z.string().optional() })),
});
const ShowOutput = z.object({ mcpServers: z.array(Server) });
const InstallOutput = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ plugin: z.object({ id: z.string().min(1) }) }),
]);

/** `bb agent-plugins` driven through the `bb` CLI; the arguments never carry secrets. */
export class BridgeCli implements BridgePort {
  constructor(
    private readonly bbPath: string = "bb",
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  private run(args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(
        this.bbPath,
        ["agent-plugins", ...args, "--json"],
        { maxBuffer: 16 * 1024 * 1024, timeout: 120_000, ...(this.env === undefined ? {} : { env: this.env }) },
        (error, stdout, stderr) => {
          if (error !== null) {
            const text = String(stderr).trim();
            reject(new Error(text.length > 0 ? text : error.message));
            return;
          }
          const out = String(stdout).trim();
          if (out === "") return resolve(null);
          try {
            resolve(JSON.parse(out));
          } catch {
            reject(new Error("bb вернул не JSON"));
          }
        },
      );
    });
  }

  async list(): Promise<BridgePlugin[]> {
    return z.array(Plugin).parse(await this.run(["list"]));
  }

  async show(id: string): Promise<{ mcpServers: BridgeServer[] }> {
    return ShowOutput.parse(await this.run(["show", id]));
  }

  async install(path: string): Promise<{ id: string }> {
    const parsed = InstallOutput.parse(await this.run(["install", path]));
    return { id: "id" in parsed ? parsed.id : parsed.plugin.id };
  }

  async update(id: string): Promise<void> {
    await this.run(["update", id]);
  }

  async remove(id: string): Promise<void> {
    await this.run(["remove", id]);
  }

  async approve(id: string, serverId: string): Promise<void> {
    await this.run(["approve", id, serverId]);
  }

  async auth(id: string, serverId: string): Promise<{ url?: string }> {
    const out = await this.run(["auth", id, serverId]);
    const url = z.object({ url: z.string() }).safeParse(out);
    return url.success ? { url: url.data.url } : {};
  }

  /**
   * Tool counts for the given servers: the bridge lists tools in pages of at most 200. A tool belongs to the
   * known row whose `<pluginId>__<serverId>__` prefixes its opaqueId and whose serverId matches; the longest
   * such prefix wins, so a plugin id that itself contains `__<serverId>__` cannot steal another row's tools.
   */
  async toolCounts(known: { pluginId: string; serverId: string }[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (let page = 0; page < 100; page++) {
      const out = ToolsOutput.parse(await this.run(["tools", "--limit", String(TOOLS_PAGE), "--offset", String(page * TOOLS_PAGE)]));
      for (const tool of out.tools) {
        if (tool.status === "error") continue;
        let owner: { pluginId: string; serverId: string } | undefined;
        for (const row of known) {
          if (row.serverId !== tool.serverId || !tool.opaqueId.startsWith(`${row.pluginId}__${row.serverId}__`)) continue;
          if (owner === undefined || row.pluginId.length > owner.pluginId.length) owner = row;
        }
        if (owner === undefined) continue;
        const key = `${owner.pluginId}/${owner.serverId}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      if (out.tools.length < TOOLS_PAGE) break;
    }
    return counts;
  }

  async setEnabled(id: string, serverId: string, enabled: boolean): Promise<void> {
    await this.run([enabled ? "enable" : "disable", id, serverId]);
  }
}
