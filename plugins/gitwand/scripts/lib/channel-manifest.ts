// channel.json for a runtime release: one archive per platform, published as
// release assets. The result is checked with the same parser the plugin uses
// before it trusts a channel (src/core/update-channel.ts).
import { parseChannelManifest } from "../../src/core/update-channel.ts";
import { RUNTIME_PLATFORMS } from "../../src/core/versions.ts";

export interface ChannelArchive {
  /** Archive file name as build-runtime.ts writes it. */
  file: string;
  sha256: string;
  size: number;
}

export interface ChannelInput {
  version: string;
  gitwandTag: string;
  commit: string;
  minPluginVersion: string;
  /** Release download URL the assets live under, without a trailing slash. */
  baseUrl: string;
  archives: ChannelArchive[];
}

/** The asset name a release uses: "+" (in "+bbN") becomes "-", which hosts keep as is. */
export function releaseAssetName(file: string): string {
  return file.replace(/\+/g, "-");
}

export function buildChannelManifest(input: ChannelInput): string {
  if (input.archives.length === 0) throw new Error("no archives for the channel");
  const platforms: Record<string, { url: string; sha256: string; size: number }> = {};
  for (const archive of input.archives) {
    const platform = RUNTIME_PLATFORMS.find((p) => archive.file === `gitwand-runtime-${input.version}-${p}.tar.gz`);
    if (platform === undefined) throw new Error(`${archive.file} is not an archive of ${input.version} for a known platform`);
    if (platform in platforms) throw new Error(`two archives for ${platform}`);
    platforms[platform] = { url: `${input.baseUrl}/${releaseAssetName(archive.file)}`, sha256: archive.sha256, size: archive.size };
  }
  const sorted = Object.fromEntries(Object.keys(platforms).sort().map((p) => [p, platforms[p]]));
  const text =
    JSON.stringify(
      { version: input.version, gitwandTag: input.gitwandTag, commit: input.commit, minPluginVersion: input.minPluginVersion, platforms: sorted },
      null,
      2,
    ) + "\n";
  parseChannelManifest(text);
  return text;
}
