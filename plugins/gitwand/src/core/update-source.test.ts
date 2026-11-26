import { describe, expect, it } from "vitest";
import { parseMinisignPublicKey } from "./minisign.ts";
import { RELEASE_CHANNEL_URL, RELEASE_PUBLIC_KEY, updateSource } from "./update-source.ts";

const KEY = "untrusted comment: minisign public key\nRWQBAgMEBQYHCKCm2o2isGk5eGQRQYR/4EqQ7PViHojAa1iAXr+RLXkH";

describe("release constants", () => {
  it("point at the release channel of the GitWand-bb repository", () => {
    expect(RELEASE_CHANNEL_URL).toBe("https://github.com/Mesteriis/GitWand-bb/releases/latest/download/channel.json");
  });

  it("carry the owner's minisign public key 24041B7E27AE78BE", () => {
    // minisign prints the key id as a little-endian number; the file stores its bytes.
    const key = parseMinisignPublicKey(RELEASE_PUBLIC_KEY ?? "");
    expect(key.keyId.match(/../g)!.reverse().join("").toUpperCase()).toBe("24041B7E27AE78BE");
  });
});

describe("updateSource", () => {
  it("uses the release channel and key when the settings are empty", () => {
    expect(updateSource({ url: "", key: "" }, { url: RELEASE_CHANNEL_URL, key: KEY })).toEqual({ kind: "on", url: RELEASE_CHANNEL_URL, key: KEY });
  });

  it("lets the settings replace the channel and the key", () => {
    expect(updateSource({ url: " https://stand.invalid/channel.json ", key: ` ${KEY} ` }, { url: RELEASE_CHANNEL_URL, key: null })).toEqual({
      kind: "on",
      url: "https://stand.invalid/channel.json",
      key: KEY,
    });
  });

  it("is off without any public key, whatever the channel", () => {
    expect(updateSource({ url: "https://stand.invalid/channel.json", key: "" }, { url: RELEASE_CHANNEL_URL, key: null })).toEqual({
      kind: "off",
      reason: "no signing key for the update channel",
    });
  });
});
