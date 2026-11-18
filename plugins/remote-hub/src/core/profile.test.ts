import { describe, expect, it } from "vitest";
import {
  LOCAL_EXECUTION_HOST_ID,
  parseCredentialRef,
  profileFieldsSchema,
  profileSchema,
} from "./profile.ts";

const SSH_FIELDS = {
  name: "build box",
  protocol: "ssh",
  group: "lab",
  tags: ["linux"],
  favorite: false,
  color: null,
  host: "build.example.test",
  port: 2222,
  username: "ci",
  domain: null,
  authType: "key",
  identityFile: "/Users/dev/.ssh/id_ed25519",
  credentialRef: null,
  rdpWidth: null,
  rdpHeight: null,
} as const;

const RDP_FIELDS = {
  name: "win",
  protocol: "rdp",
  group: null,
  tags: [],
  favorite: true,
  color: "#3a7d44",
  host: "win.example.test",
  port: null,
  username: "Administrator",
  domain: "CORP",
  authType: "password",
  identityFile: null,
  credentialRef: null,
  rdpWidth: 1280,
  rdpHeight: 800,
} as const;

const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";

describe("profile fields", () => {
  it("accepts a complete SSH and a complete RDP profile", () => {
    expect(profileFieldsSchema.safeParse(SSH_FIELDS).success).toBe(true);
    expect(profileFieldsSchema.safeParse(RDP_FIELDS).success).toBe(true);
  });

  it("refuses every secret-shaped field: the schema is strict", () => {
    for (const key of ["password", "passphrase", "secret", "privateKey", "token", "sealed"]) {
      const result = profileFieldsSchema.safeParse({ ...SSH_FIELDS, [key]: "hunter2" });
      expect(result.success, key).toBe(false);
    }
  });

  it("an RDP profile needs a username, password auth and no key file", () => {
    expect(profileFieldsSchema.safeParse({ ...RDP_FIELDS, username: null }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...RDP_FIELDS, authType: "agent" }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...RDP_FIELDS, identityFile: "/k" }).success).toBe(false);
  });

  it("an SSH profile has no domain or desktop size, and key auth needs a key file", () => {
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, domain: "CORP" }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, rdpWidth: 800, rdpHeight: 600 }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, identityFile: null }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, authType: "agent", identityFile: null }).success).toBe(true);
  });

  it("refuses a host the SSH rules refuse, a bad port, a relative key path and a bad colour", () => {
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, host: "-oProxyCommand=x" }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, host: "a b" }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, port: 0 }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, port: 65536 }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, identityFile: "id_rsa" }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...RDP_FIELDS, color: "green" }).success).toBe(false);
  });

  it("trims the name and refuses an empty one; tags are trimmed, unique and at most 20", () => {
    expect(profileFieldsSchema.parse({ ...SSH_FIELDS, name: "  box  " }).name).toBe("box");
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, name: "   " }).success).toBe(false);
    expect(profileFieldsSchema.parse({ ...SSH_FIELDS, tags: [" a ", "a", "b"] }).tags).toEqual(["a", "b"]);
    const many = Array.from({ length: 21 }, (_, i) => "t" + i);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, tags: many }).success).toBe(false);
  });
});

describe("credentialRef", () => {
  it("parses the scoped reference into execution host and id", () => {
    expect(parseCredentialRef(REF)).toEqual({ executionHostId: "local", id: "0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a" });
  });

  it("refuses anything that is not a reference, including a secret pasted into the field", () => {
    expect(parseCredentialRef("hunter2")).toBeNull();
    expect(parseCredentialRef("rh-cred:v2:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a")).toBeNull();
    expect(parseCredentialRef("rh-cred:v1::0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a")).toBeNull();
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, authType: "password", identityFile: null, credentialRef: "hunter2" }).success).toBe(false);
  });

  it("a stored profile whose reference names another execution host is refused", () => {
    const base = { ...SSH_FIELDS, authType: "password", identityFile: null };
    const stored = {
      ...base,
      id: "11111111-2222-4333-8444-555555555555",
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      origin: "manual",
      createdAt: "2026-11-18T10:00:00.000Z",
      updatedAt: "2026-11-18T10:00:00.000Z",
      lastOpenedAt: null,
      recentErrors: [],
    };
    expect(profileSchema.safeParse({ ...stored, credentialRef: REF }).success).toBe(true);
    expect(
      profileSchema.safeParse({ ...stored, credentialRef: "rh-cred:v1:other-mac:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a" }).success,
    ).toBe(false);
  });
});
