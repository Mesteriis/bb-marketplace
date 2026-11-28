import { describe, expect, it } from "vitest";
import {
  checkEntryName, checkExtractLimits, classifyEntry, findCollisions, EXTRACT_LIMITS, nameRefusal,
} from "./archive-guard.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("checkEntryName", () => {
  it("refuses traversal, absolute, drive, backslash and malformed names", () => {
    for (const name of ["../x", "/abs", "C:\\x", "a/../../b", "a\\b", "a//b", "a\0b", "", "a/./b", ".", "..", "//server/share", "c:/x"]) {
      expect(checkEntryName(name), JSON.stringify(name)).toBe("refused");
    }
  });
  it("accepts ordinary names and one trailing slash", () => {
    expect(checkEntryName("a/b/")).toEqual([{ t: "a" }, { t: "b" }]);
    expect(checkEntryName("file.txt")).toEqual([{ t: "file.txt" }]);
    expect(checkEntryName(enc("café/x"))).toEqual([{ t: "café" }, { t: "x" }]);
  });
  it("refuses control characters, over-long segments and non UTF-8 bytes", () => {
    expect(checkEntryName("a\u0007b")).toBe("refused");
    expect(checkEntryName("a".repeat(256))).toBe("refused");
    expect(checkEntryName("a".repeat(255))).toEqual([{ t: "a".repeat(255) }]);
    expect(checkEntryName(Uint8Array.from([0x63, 0x61, 0x66, 0x82]))).toBe("refused");
  });
  it("names the refusal reason", () => {
    expect(nameRefusal("../x")).toBe("unsafe_name");
    expect(nameRefusal("/abs")).toBe("unsafe_name");
    expect(nameRefusal("a\\b")).toBe("backslash");
    expect(nameRefusal("C:\\x")).toBe("backslash");
    expect(nameRefusal(Uint8Array.from([0x63, 0x61, 0x66, 0x82]))).toBe("name_encoding");
    expect(nameRefusal("ok/name")).toBeNull();
  });
});

describe("classifyEntry", () => {
  const file = { kind: "file" as const, name: "a/b.txt", encrypted: false };
  it("passes a normal file and directory", () => {
    expect(classifyEntry(file, { hasPassword: false })).toBeNull();
    expect(classifyEntry({ kind: "dir", name: "a/", encrypted: false }, { hasPassword: false })).toBeNull();
  });
  it("refuses symlinks and hardlinks always; link_escapes when the target leaves the root", () => {
    expect(classifyEntry({ kind: "symlink", name: "a/l", link: "b.txt", encrypted: false }, { hasPassword: false })).toBe("link_not_supported");
    expect(classifyEntry({ kind: "symlink", name: "a/l", link: "../../outside", encrypted: false }, { hasPassword: false })).toBe("link_escapes");
    expect(classifyEntry({ kind: "symlink", name: "l", link: "/etc/passwd", encrypted: false }, { hasPassword: false })).toBe("link_escapes");
    expect(classifyEntry({ kind: "hardlink", name: "h", link: "../x", encrypted: false }, { hasPassword: false })).toBe("link_escapes");
    expect(classifyEntry({ kind: "hardlink", name: "h", link: "x", encrypted: false }, { hasPassword: false })).toBe("link_not_supported");
  });
  it("counts a hardlink target from the archive root and a symlink target from the entry's directory", () => {
    const entry = (kind: "symlink" | "hardlink") => ({ kind, name: "d/l", link: "../x", encrypted: false });
    expect(classifyEntry(entry("symlink"), { hasPassword: false })).toBe("link_not_supported");
    expect(classifyEntry(entry("hardlink"), { hasPassword: false })).toBe("link_escapes");
    expect(classifyEntry({ kind: "hardlink", name: "d/l", link: "a/../b", encrypted: false }, { hasPassword: false })).toBe("link_not_supported");
  });
  it("an empty target and an encrypted link are link_escapes, an ordinary x is link_not_supported", () => {
    const entry = { kind: "symlink" as const, name: "l", encrypted: false };
    expect(classifyEntry({ ...entry, link: "" }, { hasPassword: false })).toBe("link_escapes");
    expect(classifyEntry({ ...entry, link: "x", encrypted: true }, { hasPassword: false })).toBe("link_escapes");
    expect(classifyEntry({ ...entry, link: "x" }, { hasPassword: false })).toBe("link_not_supported");
  });
  it("a target longer than 4096 bytes, or one that is missing, counts as escaping", () => {
    const at = (link: string) => classifyEntry({ kind: "symlink", name: "l", link, encrypted: false }, { hasPassword: false });
    expect(at("a".repeat(4096))).toBe("link_not_supported");
    expect(at("a".repeat(4097))).toBe("link_escapes");
    expect(at("/" + "a".repeat(4096))).toBe("link_escapes");
    expect(classifyEntry({ kind: "symlink", name: "l", encrypted: false }, { hasPassword: false })).toBe("link_escapes");
  });
  it("refuses special files, unsafe names and encrypted entries without a password", () => {
    expect(classifyEntry({ kind: "special", name: "dev", encrypted: false }, { hasPassword: false })).toBe("special_file");
    expect(classifyEntry({ kind: "file", name: "../x", encrypted: false }, { hasPassword: false })).toBe("unsafe_name");
    expect(classifyEntry({ ...file, encrypted: true }, { hasPassword: false })).toBe("encrypted_no_password");
    expect(classifyEntry({ ...file, encrypted: true }, { hasPassword: true })).toBeNull();
  });
});

describe("findCollisions", () => {
  it("marks later entries whose NFC or case-folded path repeats, on a case-insensitive target", () => {
    const entries = [
      { name: "a/File.txt", kind: "file" as const },
      { name: "a/file.txt", kind: "file" as const },
      { name: "a/caf\u00e9", kind: "file" as const },
      { name: "a/cafe\u0301", kind: "file" as const },
    ];
    expect([...findCollisions(entries, false)]).toEqual([1, 3]);
    expect([...findCollisions(entries, true)]).toEqual([3]);
  });
  it("marks a file and a directory with the same path, and an entry below a file", () => {
    expect([...findCollisions([{ name: "a", kind: "file" }, { name: "a/", kind: "dir" }], true)]).toEqual([1]);
    expect([...findCollisions([{ name: "a", kind: "file" }, { name: "a/b", kind: "file" }], true)]).toEqual([1]);
  });
});

describe("checkExtractLimits", () => {
  it("has the default limits from the plan", () => {
    expect(EXTRACT_LIMITS).toEqual({ maxTotalBytes: 10 * 2 ** 30, maxEntries: 100_000, maxRatio: 100 });
  });
  it("accepts exactly 100 000 entries and refuses 100 001", () => {
    expect(checkExtractLimits({ entries: 100_000, totalBytes: 0n, compressedBytes: 1n }, EXTRACT_LIMITS)).toBeNull();
    const refusal = checkExtractLimits({ entries: 100_001, totalBytes: 0n, compressedBytes: 1n }, EXTRACT_LIMITS);
    expect(refusal?.toShape()).toEqual({ code: "limit_exceeded", message: "Archive has too many entries", retryable: false, reason: "too_many_entries" });
  });
  it("refuses total bytes over the limit", () => {
    const refusal = checkExtractLimits({ entries: 1, totalBytes: BigInt(10 * 2 ** 30) + 1n, compressedBytes: 2n ** 40n }, EXTRACT_LIMITS);
    expect(refusal?.reason).toBe("total_bytes");
  });
  it("applies the archive ratio only from 1 MiB of output", () => {
    expect(checkExtractLimits({ entries: 1, totalBytes: 1048575n, compressedBytes: 1n }, EXTRACT_LIMITS)).toBeNull();
    expect(checkExtractLimits({ entries: 1, totalBytes: 1048576n, compressedBytes: 10485n }, EXTRACT_LIMITS)?.reason).toBe("ratio");
    expect(checkExtractLimits({ entries: 1, totalBytes: 1048576n, compressedBytes: 10486n }, EXTRACT_LIMITS)).toBeNull();
  });
  it("honours a raised ratio", () => {
    expect(checkExtractLimits({ entries: 1, totalBytes: 1048576n, compressedBytes: 1n }, { ...EXTRACT_LIMITS, maxRatio: 2 ** 21 })).toBeNull();
  });
});
