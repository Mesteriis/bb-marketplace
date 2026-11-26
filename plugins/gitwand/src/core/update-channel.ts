// The signed update channel: `channel.json` names the newest runtime build and
// an archive per platform. The signature is checked before this parser runs
// (minisign.ts and the adapter that verifies it).
import { z } from "zod";
import { compareRuntimeVersions, compareSemver, parseRuntimeVersion, RUNTIME_PLATFORMS, type RuntimePlatform } from "./versions.ts";

const archive = z.object({
  url: z.string().regex(/^https:\/\/[^\s]+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
});

const manifestSchema = z.object({
  version: z.string().refine((v) => parseRuntimeVersion(v) !== null),
  gitwandTag: z.string().regex(/^v\d+\.\d+\.\d+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  minPluginVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  platforms: z.partialRecord(z.enum(RUNTIME_PLATFORMS), archive),
});

export type ChannelManifest = z.infer<typeof manifestSchema>;

export function parseChannelManifest(text: string): ChannelManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("invalid channel manifest: not JSON");
  }
  const parsed = manifestSchema.strict().safeParse(data);
  if (!parsed.success) throw new Error(`invalid channel manifest: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`);
  return parsed.data;
}

export type UpdateChoice =
  | { kind: "none" }
  | { kind: "needs-plugin"; minPluginVersion: string }
  | { kind: "available"; version: string; url: string; sha256: string; size: number };

/** What the channel offers to this installation. Never offers an older or equal build. */
export function selectUpdate(
  manifest: ChannelManifest,
  current: { installed: string | null; pluginVersion: string; platform: RuntimePlatform },
): UpdateChoice {
  const build = manifest.platforms[current.platform];
  if (build === undefined) return { kind: "none" };
  if (current.installed !== null && compareRuntimeVersions(manifest.version, current.installed) <= 0) return { kind: "none" };
  if (compareSemver(current.pluginVersion, manifest.minPluginVersion) < 0) return { kind: "needs-plugin", minPluginVersion: manifest.minPluginVersion };
  return { kind: "available", version: manifest.version, ...build };
}
