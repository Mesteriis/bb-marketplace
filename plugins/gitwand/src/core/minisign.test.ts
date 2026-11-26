import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMinisignPublicKey, parseMinisignSignature } from "./minisign.ts";

const fixture = (name: string) => readFileSync(new URL(`../../tests/fixtures/minisign/${name}`, import.meta.url), "utf8");

describe("parseMinisignPublicKey", () => {
  it("reads key id and the 32-byte Ed25519 key", () => {
    const key = parseMinisignPublicKey(fixture("test-key.pub"));
    expect(key.keyId).toBe("0102030405060708");
    expect(key.publicKey.length).toBe(32);
  });

  it.each([
    ["one line", "RWQ"],
    ["a wrong algorithm", "untrusted comment: x\n" + btoa("XX" + "\u0001".repeat(40))],
    ["a short key", "untrusted comment: x\n" + btoa("Ed" + "\u0001".repeat(20))],
  ])("refuses %s", (_name, text) => {
    expect(() => parseMinisignPublicKey(text)).toThrow(/minisign public key/);
  });
});

describe("parseMinisignSignature", () => {
  it("reads a prehashed signature with its trusted comment", () => {
    const sig = parseMinisignSignature(fixture("channel.json.minisig"));
    expect(sig).toMatchObject({ algorithm: "ED", keyId: "0102030405060708", trustedComment: "timestamp:1764115200\tfile:channel.json\thashed" });
    expect(sig.signature.length).toBe(64);
    expect(sig.globalSignature.length).toBe(64);
  });

  it("reads a legacy signature over the raw file", () => {
    expect(parseMinisignSignature(fixture("channel.json.legacy.minisig")).algorithm).toBe("Ed");
  });

  it.each([
    ["three lines", "untrusted comment: x\nAAAA\ntrusted comment: y\n"],
    ["no trusted comment prefix", fixture("channel.json.minisig").replace("\ntrusted comment: ", "\ncomment: ")],
  ])("refuses %s", (_name, text) => {
    expect(() => parseMinisignSignature(text)).toThrow(/minisign signature/);
  });
});
