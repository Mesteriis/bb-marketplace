import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base64Bytes, sftpOpOutputSchema } from "../../core/wire/remote-hub-sftp.ts";
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

describe("the Remote Hub contract mirror", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const functionText = (text: string) => /export function base64Bytes[\s\S]*?\n}\n/.exec(text)?.[0];
  it("keeps base64Bytes and the base64 schema byte for byte as in plugins/remote-hub", () => {
    const mirror = source("../../core/wire/remote-hub-sftp.ts");
    const hub = source("../../../../remote-hub/src/core/sftp-contract.ts");
    expect(functionText(mirror)).toBeDefined();
    expect(functionText(mirror)).toBe(functionText(hub));
    const schemaText = (text: string) => /const base64Schema =[\s\S]*?\}, "[^"]*"\);\n/.exec(text)?.[0];
    expect(schemaText(mirror)).toBeDefined();
    expect(schemaText(mirror)).toBe(schemaText(hub));
  });
});
