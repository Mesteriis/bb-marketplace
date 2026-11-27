import { describe, expect, it } from "vitest";
import {
  SFTP_LIMITS,
  SFTP_REFUSALS,
  levelAllows,
  neededLevel,
  sftpAttrsSchema,
  sftpChannelEventSchema,
  sftpMethods,
  sftpOpInputSchema,
  base64Bytes,
  sftpPathSchema,
  uint64Schema,
} from "./sftp-contract.ts";

const CH = "6f2c1f0e-1c2d-4b7a-9d3e-0a1b2c3d4e5f";
const P = "5b568675-f842-4a96-83e0-78ae53d96024";

describe("paths", () => {
  it("is text, or the raw bytes in base64 for a name that is not valid UTF-8; never both, never empty", () => {
    expect(sftpPathSchema.safeParse({ text: "/etc/hosts" }).success).toBe(true);
    expect(sftpPathSchema.safeParse({ bytes: "L3RtcC//" }).success).toBe(true);
    expect(sftpPathSchema.safeParse({ text: "/a", bytes: "L2E=" }).success).toBe(false);
    expect(sftpPathSchema.safeParse({ text: "" }).success).toBe(false);
    expect(sftpPathSchema.safeParse({ bytes: "not base64!" }).success).toBe(false);
    expect(sftpPathSchema.safeParse("/etc/hosts").success).toBe(false);
  });

  it("refuses a text path with a NUL in it", () => {
    expect(sftpPathSchema.safeParse({ text: "/tmp/a\u0000b" }).success).toBe(false);
  });
});

describe("base64Bytes", () => {
  it("counts the decoded bytes with the padding", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes("aGk=")).toBe(2);
    expect(base64Bytes("aA==")).toBe(1);
    expect(base64Bytes("aGkh")).toBe(3);
    expect(base64Bytes("aGk")).toBeNull();
    expect(base64Bytes("=Gk=")).toBeNull();
  });
});

describe("uint64", () => {
  it("is a decimal string up to 18446744073709551615, with no sign, spaces or leading zeros", () => {
    expect(uint64Schema.safeParse("0").success).toBe(true);
    expect(uint64Schema.safeParse("18446744073709551615").success).toBe(true);
    expect(uint64Schema.safeParse("18446744073709551616").success).toBe(false);
    expect(uint64Schema.safeParse("007").success).toBe(false);
    expect(uint64Schema.safeParse("-1").success).toBe(false);
    expect(uint64Schema.safeParse(5).success).toBe(false);
  });
});

describe("limits", () => {
  it("are the ones Commander was told", () => {
    expect(SFTP_LIMITS).toEqual({ chunkBytes: 4194304, channelsPerPlugin: 4, listPage: 1000, listTotal: 10000, pathBytes: 4096, reasonChars: 200 });
  });
});

describe("operations", () => {
  const ok = (op: object) => sftpOpInputSchema.safeParse({ channelId: CH, ...op }).success;

  it("accepts each operation in its own shape and nothing else", () => {
    expect(ok({ op: "list", path: { text: "/var" } })).toBe(true);
    expect(ok({ op: "list", path: { text: "/var" }, cursor: "abc", limit: 1000 })).toBe(true);
    expect(ok({ op: "stat", path: { text: "/var" }, follow: true })).toBe(true);
    expect(ok({ op: "realpath", path: { text: "." } })).toBe(true);
    expect(ok({ op: "read", path: { text: "/f" }, offset: "0", length: 4194304 })).toBe(true);
    expect(ok({ op: "write", path: { text: "/f" }, offset: "0", data: "aGk=", create: "exclusive" })).toBe(true);
    expect(ok({ op: "mkdir", path: { text: "/d" } })).toBe(true);
    expect(ok({ op: "rename", from: { text: "/a" }, to: { text: "/b" }, overwrite: false })).toBe(true);
    expect(ok({ op: "remove", path: { text: "/a" }, kind: "file" })).toBe(true);
    expect(ok({ op: "chmod", path: { text: "/a" } })).toBe(false);
    expect(ok({ op: "list", path: { text: "/var" }, extra: 1 })).toBe(false);
  });

  it("refuses a page or a chunk over the limit", () => {
    expect(ok({ op: "list", path: { text: "/var" }, limit: 1001 })).toBe(false);
    expect(ok({ op: "read", path: { text: "/f" }, offset: "0", length: 4194305 })).toBe(false);
    expect(ok({ op: "read", path: { text: "/f" }, offset: "0", length: 0 })).toBe(false);
  });

  it("a write says how the file is opened: exclusive and truncate start at offset 0, existing continues anywhere", () => {
    expect(ok({ op: "write", path: { text: "/f" }, offset: "0", data: "aGk=", create: "truncate" })).toBe(true);
    expect(ok({ op: "write", path: { text: "/f" }, offset: "4194304", data: "aGk=", create: "existing" })).toBe(true);
    expect(ok({ op: "write", path: { text: "/f" }, offset: "5", data: "aGk=", create: "exclusive" })).toBe(false);
    expect(ok({ op: "write", path: { text: "/f" }, offset: "5", data: "aGk=", create: "truncate" })).toBe(false);
    expect(ok({ op: "write", path: { text: "/f" }, offset: "0", data: "aGk=" })).toBe(false);
    expect(ok({ op: "write", path: { text: "/f" }, offset: "0", data: "", create: "truncate" })).toBe(true); // an empty file
  });

  it("takes a chunk of exactly 4 MiB and refuses one or two bytes more, whatever the padding", () => {
    const chunk = (bytes: number) => Buffer.alloc(bytes, 0x61).toString("base64");
    const write = (data: string) => sftpOpInputSchema.safeParse({ channelId: CH, op: "write", path: { text: "/f" }, offset: "0", data, create: "truncate" }).success;
    expect(write(chunk(4194304))).toBe(true);
    expect(write(chunk(4194305))).toBe(false);
    expect(write(chunk(4194306))).toBe(false);
    expect(write(chunk(4194303))).toBe(true);
  });

  it("refuses base64 that is not canonical: a wrong length, a foreign character, padding in the middle or three pads", () => {
    const write = (data: string) => sftpOpInputSchema.safeParse({ channelId: CH, op: "write", path: { text: "/f" }, offset: "0", data, create: "truncate" }).success;
    expect(write("aGk=")).toBe(true);
    expect(write("aGk")).toBe(false);
    expect(write("aG k")).toBe(false);
    expect(write("a=k=")).toBe(false);
    expect(write("a===")).toBe(false);
    expect(write("aGk-")).toBe(false); // the URL alphabet is not accepted
  });

  it("needs the read level to look and the write level to change anything", () => {
    expect((["list", "stat", "realpath", "read"] as const).map(neededLevel)).toEqual(["read", "read", "read", "read"]);
    expect((["write", "mkdir", "rename", "remove"] as const).map(neededLevel)).toEqual(["write", "write", "write", "write"]);
    expect(levelAllows("read", "read")).toBe(true);
    expect(levelAllows("read", "write")).toBe(false);
    expect(levelAllows("write", "read")).toBe(true);
    expect(levelAllows("write", "write")).toBe(true);
  });
});

describe("attributes", () => {
  it("carry the size as a uint64 string, the server's own mtime in seconds, and a link's target", () => {
    const attrs = { type: "symlink", size: "12", mtime: 1795790479, mode: 0o120777, linkTarget: { text: "../real" } };
    expect(sftpAttrsSchema.parse(attrs)).toEqual(attrs);
    expect(sftpAttrsSchema.safeParse({ ...attrs, size: 12 }).success).toBe(false);
    expect(sftpAttrsSchema.safeParse({ type: "file", size: "0", mtime: null, mode: null, linkTarget: null }).success).toBe(true);
  });
});

describe("methods", () => {
  it("are the six Commander calls", () => {
    expect(Object.keys(sftpMethods)).toEqual(["hub_sftp_profiles", "hub_sftp_request_access", "hub_sftp_grants", "hub_sftp_open", "hub_sftp_op", "hub_sftp_close"]);
  });

  it("a profile row has no field for a secret, a key path or a credential reference", () => {
    const row = { id: P, name: "web", group: null, host: "h.example.test", port: 22, user: "root", authType: "key", consent: "none", level: null, hostKey: "unknown", needsConfig: false };
    const schema = sftpMethods.hub_sftp_profiles.output;
    expect(schema.safeParse({ profiles: [row] }).success).toBe(true);
    for (const extra of ["identityFile", "credentialRef", "password"]) expect(schema.safeParse({ profiles: [{ ...row, [extra]: "x" }] }).success).toBe(false);
  });

  it("the plugin's id is never an input: a request names only the profile, the level and a reason", () => {
    const input = sftpMethods.hub_sftp_request_access.input;
    expect(input.safeParse({ profileId: P, level: "write", reason: "copy logs" }).success).toBe(true);
    expect(input.safeParse({ profileId: P, level: "write", pluginId: "evil" }).success).toBe(false);
    expect(input.safeParse({ profileId: P, level: "admin" }).success).toBe(false);
  });

  it("open answers with the channel and the helper generation it lives in", () => {
    expect(sftpMethods.hub_sftp_open.output.safeParse({ channelId: CH, generation: "0123456789abcdef0123456789abcdef" }).success).toBe(true);
  });
});

describe("refusals and events", () => {
  it("every stable code maps to one of the host's four refusal classes; there is no expiry code", () => {
    expect(SFTP_REFUSALS.caller_not_plugin).toBe("forbidden");
    expect(SFTP_REFUSALS.consent_required).toBe("forbidden");
    expect(SFTP_REFUSALS.consent_revoked).toBe("forbidden");
    expect(SFTP_REFUSALS.host_key_unknown).toBe("forbidden");
    expect(SFTP_REFUSALS.host_key_changed).toBe("forbidden");
    expect(SFTP_REFUSALS.profile_not_found).toBe("not_found");
    expect(SFTP_REFUSALS.profile_needs_config).toBe("conflict");
    expect(SFTP_REFUSALS.agent_unavailable).toBe("conflict");
    expect(SFTP_REFUSALS.keychain_unavailable).toBe("conflict");
    expect(SFTP_REFUSALS.limit_exceeded).toBe("invalid");
    expect("consent_expired" in SFTP_REFUSALS).toBe(false);
    for (const cls of Object.values(SFTP_REFUSALS)) expect(["forbidden", "not_found", "conflict", "invalid"]).toContain(cls);
  });

  it("a dead channel has two codes: channel_closed when nothing was sent, outcome_unknown when a change was sent and not answered", () => {
    expect(SFTP_REFUSALS.channel_closed).toBe("not_found");
    expect(SFTP_REFUSALS.outcome_unknown).toBe("conflict");
  });

  it("a channel event names the channel and its state, nothing else", () => {
    expect(sftpChannelEventSchema.safeParse({ channelId: CH, state: "revoked" }).success).toBe(true);
    expect(sftpChannelEventSchema.safeParse({ channelId: CH, state: "open", host: "h" }).success).toBe(false);
  });
});
