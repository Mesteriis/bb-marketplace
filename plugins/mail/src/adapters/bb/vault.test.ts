import { describe, expect, it } from "vitest";
import { createVault, generateVaultKey } from "./vault.ts";

describe("vault", () => {
  it("round-trips", () => {
    const vault = createVault(generateVaultKey());
    const sealed = vault.seal("invented app password");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("invented app password");
    expect(vault.open(sealed)).toBe("invented app password");
  });

  it("rejects a tampered value", () => {
    const vault = createVault(generateVaultKey());
    const sealed = vault.seal("invented app password");
    const bytes = Buffer.from(sealed.slice(3), "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
    const tampered = `v1:${bytes.toString("base64")}`;
    expect(() => vault.open(tampered)).toThrow("Cannot decrypt credential");
    expect(() => vault.open("v1:AAAA")).toThrow("Cannot decrypt credential");
    expect(() => vault.open("plain text")).toThrow("Cannot decrypt credential");
  });

  it("rejects a wrong key", () => {
    const sealed = createVault(generateVaultKey()).seal("invented app password");
    expect(() => createVault(generateVaultKey()).open(sealed)).toThrow(
      "Cannot decrypt credential",
    );
  });

  it("two seals of one value differ", () => {
    const vault = createVault(generateVaultKey());
    expect(vault.seal("same")).not.toBe(vault.seal("same"));
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => createVault(Buffer.alloc(16).toString("base64"))).toThrow(
      "Vault key must be 32 bytes",
    );
  });

  it("generates a 32-byte base64 key", () => {
    expect(Buffer.from(generateVaultKey(), "base64")).toHaveLength(32);
  });
});
