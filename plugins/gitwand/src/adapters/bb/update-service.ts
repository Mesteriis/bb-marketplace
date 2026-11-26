// Checks the signed update channel: channel.json and channel.json.minisig,
// verified with the plugin's public key before anything in them is trusted.
// Without a channel URL or a key, updates are off and the installed runtime
// stays as it is.
import { parseChannelManifest, selectUpdate } from "../../core/update-channel.ts";
import type { RuntimePlatform } from "../../core/versions.ts";
import { verifyMinisign } from "./minisign-verify.ts";

export type UpdateCheck =
  | { kind: "disabled" }
  | { kind: "none" }
  | { kind: "needs-plugin"; minPluginVersion: string }
  | { kind: "available"; version: string; url: string; sha256: string; size: number }
  | { kind: "error"; error: string };

export interface PendingUpdate {
  version: string;
  currentVersion: string | null;
  url: string;
  sha256: string;
  size: number;
}

export class UpdateService {
  private pendingUpdate: PendingUpdate | null = null;

  constructor(
    private readonly options: {
      channelUrl: string;
      publicKey: string;
      platform: RuntimePlatform;
      pluginVersion: string;
      installed: () => Promise<string | null>;
      fetch?: typeof fetch;
    },
  ) {}

  pending(): PendingUpdate | null {
    return this.pendingUpdate;
  }

  async check(): Promise<UpdateCheck> {
    const { channelUrl, publicKey } = this.options;
    if (channelUrl.trim() === "" || publicKey.trim() === "") return { kind: "disabled" };
    this.pendingUpdate = null;
    try {
      const [manifest, signature] = await Promise.all([this.get(channelUrl, "channel.json"), this.get(`${channelUrl}.minisig`, "channel.json.minisig")]);
      const verified = verifyMinisign(manifest, signature.toString("utf8"), publicKey);
      if (!verified.ok) return { kind: "error", error: `channel.json: ${verified.reason}` };
      const installed = await this.options.installed();
      const choice = selectUpdate(parseChannelManifest(manifest.toString("utf8")), { installed, pluginVersion: this.options.pluginVersion, platform: this.options.platform });
      if (choice.kind === "available") this.pendingUpdate = { version: choice.version, currentVersion: installed, url: choice.url, sha256: choice.sha256, size: choice.size };
      return choice;
    } catch (error) {
      return { kind: "error", error: (error as Error).message };
    }
  }

  private async get(url: string, name: string): Promise<Buffer> {
    const response = await (this.options.fetch ?? fetch)(url);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
