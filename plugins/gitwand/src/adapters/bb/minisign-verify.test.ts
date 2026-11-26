import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyMinisign } from "./minisign-verify.ts";

const fixture = (name: string) => readFileSync(new URL(`../../../tests/fixtures/minisign/${name}`, import.meta.url));
const KEY = fixture("test-key.pub").toString("utf8");
const DATA = fixture("channel.json");

describe("verifyMinisign", () => {
  it("accepts the prehashed signature made by OpenSSL", () => {
    expect(verifyMinisign(DATA, fixture("channel.json.minisig").toString("utf8"), KEY)).toEqual({ ok: true, trustedComment: "timestamp:1764115200\tfile:channel.json\thashed" });
  });

  it("accepts the legacy signature over the raw file", () => {
    expect(verifyMinisign(DATA, fixture("channel.json.legacy.minisig").toString("utf8"), KEY)).toMatchObject({ ok: true });
  });

  it("refuses a file changed by one byte", () => {
    const changed = Buffer.from(DATA);
    changed[changed.indexOf("bb2")] = "c".charCodeAt(0);
    expect(verifyMinisign(changed, fixture("channel.json.minisig").toString("utf8"), KEY)).toEqual({ ok: false, reason: "signature does not match the file" });
  });

  it("refuses an edited trusted comment", () => {
    const sig = fixture("channel.json.minisig").toString("utf8").replace("timestamp:1764115200", "timestamp:1764115201");
    expect(verifyMinisign(DATA, sig, KEY)).toEqual({ ok: false, reason: "trusted comment is not signed" });
  });

  it("refuses a signature by another key", () => {
    const other = KEY.replace(/\n(.+)\n?$/, (_m, b64: string) => {
      const raw = Buffer.from(b64, "base64");
      raw[2] ^= 0xff;
      return "\n" + raw.toString("base64") + "\n";
    });
    expect(verifyMinisign(DATA, fixture("channel.json.minisig").toString("utf8"), other)).toEqual({ ok: false, reason: "signed by another key" });
  });

  it("refuses an unreadable signature", () => {
    expect(verifyMinisign(DATA, "garbage", KEY)).toEqual({ ok: false, reason: "invalid minisign signature" });
  });
});
