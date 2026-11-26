// Where runtime updates come from: the plugin's release channel, unless the
// settings name another channel or key (a stand, a private mirror).

/** channel.json of the latest runtime release (channel.json.minisig sits next to it). */
export const RELEASE_CHANNEL_URL = "https://github.com/Mesteriis/GitWand-bb/releases/latest/download/channel.json";

/**
 * The minisign public key (both lines) that signs the release channel.
 * null until the owner creates the key and provides its public half; updates
 * stay off without a key.
 */
export const RELEASE_PUBLIC_KEY: string | null = null;

export type UpdateSource = { kind: "on"; url: string; key: string } | { kind: "off"; reason: string };

export function updateSource(settings: { url: string; key: string }, release: { url: string; key: string | null }): UpdateSource {
  const url = settings.url.trim() || release.url;
  const key = settings.key.trim() || release.key?.trim() || "";
  if (key === "") return { kind: "off", reason: "no signing key for the update channel" };
  return { kind: "on", url, key };
}
