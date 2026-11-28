import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base64Bytes, SFTP_REFUSALS, sftpOpOutputSchema } from "../../core/wire/remote-hub-sftp.ts";
import { fastBase64Bytes, sftpFastMethods } from "./sftp-fast-wire.ts";

const literals = [
  "", "AAAA", "AAA=", "AA==", "AAAAAAAA", "AB==", "ŁAAA", "AA==AAAA", "A===", "====", "-", "_", " ", "AAA ", "AA A",
  "-_8=", "AB=C", "AAA", "AAAA\n", "AA\nA", "AA=A", "éAAA", "AAAA ", "AAAAAAA=", "AĀAA", "\u{1F600}AA", "AAA!",
];

describe("the adapter's fast base64 check", () => {
  it.each(literals)("answers like the mirrored base64Bytes for %j", (text) => {
    expect(fastBase64Bytes(text)).toBe(base64Bytes(text));
  });
  it("refuses the texts the Remote Hub contract refuses", () => {
    for (const text of ["ŁAAA", "AA==AAAA", "A===", "====", "-", "_", " "]) expect(fastBase64Bytes(text)).toBeNull();
  });
  it("answers like the mirror for every character in every position of 4- and 8-character texts", () => {
    for (const base of ["AAAA", "AAA=", "AA==", "AAAAAAAA", "AAAAAAA=", "AAAAAA=="]) {
      for (let at = 0; at < base.length; at++) {
        for (let code = 0; code < 512; code++) {
          const text = base.slice(0, at) + String.fromCharCode(code) + base.slice(at + 1);
          expect(fastBase64Bytes(text), JSON.stringify(text)).toBe(base64Bytes(text));
        }
      }
    }
  });
  it("makes the read reply schema accept and refuse exactly what the mirrored schema does", () => {
    const fast = sftpFastMethods.hub_sftp_op.output;
    const chunk = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64");
    for (const data of [...literals, chunk(4194303), chunk(4194304), chunk(4194305), chunk(4194306)]) {
      const reply = { op: "read", data, eof: true };
      expect(fast.safeParse(reply).success, JSON.stringify(data).slice(0, 20)).toBe(sftpOpOutputSchema.safeParse(reply).success);
    }
    expect(fast.safeParse({ op: "write", written: 3 }).success).toBe(true);
    expect(fast.safeParse({ op: "read", data: "AAAA", eof: true, extra: 1 }).success).toBe(false);
  });
});

// Pinned from plugins/remote-hub/src/core/sftp-contract.ts on main (git blob fafdb9ad, remote-hub@271406d0), so the
// check needs nothing outside this package.
const MAIN_BASE64_BYTES_SHA256 = "bb800af39effbf277683ee971024a4e819385c9ccfbc42a39369b6c318b2bca7";
const MAIN_BASE64_SCHEMA_SHA256 = "15f5fcf77f0445b6c6edaa3761fe0f1dd073b1535b0805cbd0f3da4150160176";
const MAIN_REFUSALS = {
  caller_not_plugin: "forbidden", consent_required: "forbidden", consent_revoked: "forbidden", host_key_unknown: "forbidden",
  host_key_changed: "forbidden", permission_denied: "forbidden", profile_not_found: "not_found", channel_closed: "not_found",
  no_such_file: "not_found", profile_not_sftp: "invalid", limit_exceeded: "invalid", invalid_path: "invalid",
  profile_needs_config: "conflict", agent_unavailable: "conflict", keychain_locked: "conflict", keychain_unavailable: "conflict",
  keychain_needs_approval: "conflict", credential_missing: "conflict", auth_failed: "conflict", unreachable: "conflict",
  exists: "conflict", not_empty: "conflict", unsupported: "conflict", outcome_unknown: "conflict", failure: "conflict",
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const functionText = (text: string) => /export function base64Bytes[\s\S]*?\n}\n/.exec(text)?.[0];
const schemaText = (text: string) => /const base64Schema =[\s\S]*?\}, "[^"]*"\);\n/.exec(text)?.[0];
const here = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the Remote Hub contract mirror", () => {
  const mirror = () => here("../../core/wire/remote-hub-sftp.ts");
  it("keeps base64Bytes and the base64 schema byte for byte as on main", () => {
    expect(sha256(functionText(mirror()) ?? "")).toBe(MAIN_BASE64_BYTES_SHA256);
    expect(sha256(schemaText(mirror()) ?? "")).toBe(MAIN_BASE64_SCHEMA_SHA256);
  });
  it("carries the refusal table of main, class for class", () => {
    expect({ ...SFTP_REFUSALS }).toEqual(MAIN_REFUSALS);
  });
  // A cross-check against the neighbouring plugin's working tree; an isolated copy of Commander has no such file.
  const neighbour = new URL("../../../../remote-hub/src/core/sftp-contract.ts", import.meta.url);
  it.skipIf(!existsSync(neighbour))("matches plugins/remote-hub in this checkout where that plugin is present", () => {
    const hub = readFileSync(neighbour, "utf8");
    expect(functionText(mirror())).toBe(functionText(hub));
    expect(schemaText(mirror())).toBe(schemaText(hub));
  });
});
