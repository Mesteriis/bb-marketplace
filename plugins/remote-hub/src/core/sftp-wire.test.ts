import { describe, expect, it } from "vitest";
import { FX, PacketReader, SftpFramer, T, decodeAttrs, decodeReply, encodeRequest, hex } from "./sftp-wire.ts";

const bytes = (h: string) => Uint8Array.from(h.replace(/\s+/g, "").match(/../g)!.map((b) => parseInt(b, 16)));
const text = (s: string) => new TextEncoder().encode(s);

describe("requests", () => {
  it("INIT is length, type 1 and version 3", () => {
    expect(hex(encodeRequest({ type: "init" }))).toBe("00000005" + "01" + "00000003");
  });

  it("a request carries its type, its id and length-prefixed strings", () => {
    expect(hex(encodeRequest({ type: "lstat", id: 7, path: text("/a") }))).toBe("0000000b" + "07" + "00000007" + "00000002" + "2f61");
    expect(hex(encodeRequest({ type: "realpath", id: 1, path: text(".") }))).toBe("0000000a" + "10" + "00000001" + "00000001" + "2e");
  });

  it("OPEN carries the flags and empty attributes; READ and WRITE carry a 64-bit offset", () => {
    expect(hex(encodeRequest({ type: "open", id: 2, path: text("f"), flags: 0x1a }))).toBe("00000012" + "03" + "00000002" + "00000001" + "66" + "0000001a" + "00000000");
    expect(hex(encodeRequest({ type: "read", id: 3, handle: bytes("aabb"), offset: 4294967296n, length: 32768 }))).toBe("00000017" + "05" + "00000003" + "00000002" + "aabb" + "0000000100000000" + "00008000");
    expect(hex(encodeRequest({ type: "write", id: 4, handle: bytes("aa"), offset: 1n, data: text("hi") }))).toBe("00000018" + "06" + "00000004" + "00000001" + "aa" + "0000000000000001" + "00000002" + "6869");
  });

  it("the atomic rename is the OpenSSH extension", () => {
    const packet = encodeRequest({ type: "posix-rename", id: 9, from: text("a"), to: text("b") });
    expect(packet[4]).toBe(T.EXTENDED);
    expect(new TextDecoder().decode(packet.subarray(13, 13 + 24))).toBe("posix-rename@openssh.com");
  });
});

describe("replies", () => {
  it("VERSION lists the server's extensions", () => {
    const body = bytes("02 00000003 00000018" + hex(text("posix-rename@openssh.com")) + "00000001 31");
    expect(decodeReply(body)).toEqual({ type: "version", version: 3, extensions: { "posix-rename@openssh.com": "1" } });
  });

  it("STATUS has the id and the code", () => {
    expect(decodeReply(bytes("65 00000007 00000002 00000000 00000000"))).toEqual({ type: "status", id: 7, code: FX.NO_SUCH_FILE });
  });

  it("HANDLE and DATA return their bytes", () => {
    expect(decodeReply(bytes("66 00000001 00000002 aabb"))).toEqual({ type: "handle", id: 1, handle: bytes("aabb") });
    expect(decodeReply(bytes("67 00000002 00000002 6869"))).toEqual({ type: "data", id: 2, data: text("hi") });
  });

  it("ATTRS decodes size, mode and times; what the server did not send is null", () => {
    const attrs = "0000000d" + "0000000000000400" + "000081a4" + "00000001" + "6b0f1c2d";
    expect(decodeReply(bytes("69 00000003" + attrs))).toEqual({ type: "attrs", id: 3, attrs: { size: 1024n, mode: 0o100644, mtime: 0x6b0f1c2d } });
    expect(decodeAttrs(new PacketReader(bytes("00000000")))).toEqual({ size: null, mode: null, mtime: null });
  });

  it("NAME returns each entry's raw name and attributes and skips the long name", () => {
    const entry = "00000001 61" + "00000003 6c6f6e" + "00000004 000041ed";
    expect(decodeReply(bytes("68 00000004 00000001" + entry))).toEqual({ type: "name", id: 4, entries: [{ name: text("a"), attrs: { size: null, mode: 0o040755, mtime: null } }] });
  });

  it("a truncated or unknown reply is a protocol error, not a guess", () => {
    expect(() => decodeReply(bytes("65 000000"))).toThrow(/truncated/);
    expect(() => decodeReply(bytes("63 00000001"))).toThrow(/unknown/);
  });
});

describe("SftpFramer", () => {
  it("cuts the byte stream into packets however it is chunked", () => {
    const framer = new SftpFramer(1024);
    const stream = bytes("00000005 65 00000001" + "00000002 0102" + "00000001");
    expect(framer.push(stream.subarray(0, 3))).toEqual([]);
    expect(framer.push(stream.subarray(3, 10)).map(hex)).toEqual(["6500000001"]);
    expect(framer.push(stream.subarray(10)).map(hex)).toEqual(["0102"]);
  });

  it("refuses a packet longer than the limit, or an empty one", () => {
    expect(() => new SftpFramer(16).push(bytes("00000011"))).toThrow(/too long/);
    expect(() => new SftpFramer(16).push(bytes("00000000"))).toThrow(/empty/);
  });
});
