import { describe, expect, it } from "vitest";
import {
  LOCAL_EXECUTION_HOST_ID,
  parseCredentialRef,
  profileFieldsSchema,
  profileInputSchema,
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

describe("RDP connection options in a profile (P1)", () => {
  const OPTS = { compression: true, colorDepth: 16, wallpaper: false, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: false };
  it("an RDP profile may carry options (or none: the default applies); an SSH profile may not", () => {
    expect(profileFieldsSchema.safeParse({ ...RDP_FIELDS, rdpOptions: OPTS }).success).toBe(true);
    expect(profileFieldsSchema.safeParse({ ...RDP_FIELDS, rdpOptions: null }).success).toBe(true);
    expect(profileFieldsSchema.safeParse(RDP_FIELDS).success).toBe(true);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, rdpOptions: OPTS }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ ...SSH_FIELDS, rdpOptions: null }).success).toBe(true);
  });
  it("the options are a closed set: a depth outside 16/24/32, a free-form flag or a missing switch is refused", () => {
    for (const bad of [{ ...OPTS, colorDepth: 8 }, { ...OPTS, performanceFlags: 3 }, { ...OPTS, themes: "no" }, { compression: true }]) {
      expect(profileFieldsSchema.safeParse({ ...RDP_FIELDS, rdpOptions: bad }).success, JSON.stringify(bad)).toBe(false);
    }
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

describe("save refuses what Connect refuses (P5)", () => {
  const ok = (over: Record<string, unknown>) => profileFieldsSchema.safeParse({ ...SSH_FIELDS, ...over }).success;

  it("an SSH user must pass the ssh user rules", () => {
    expect(ok({ username: "-oProxyCommand=x" })).toBe(false);
    expect(ok({ username: "a b" })).toBe(false);
    expect(ok({ username: "ci" })).toBe(true);
  });

  it("a key file path must be absolute without control characters or dot segments", () => {
    expect(ok({ identityFile: "/Users/dev/../root/.ssh/id" })).toBe(false);
    expect(ok({ identityFile: "/Users/dev/./id" })).toBe(false);
    expect(ok({ identityFile: "/Users/dev/key\u0007" })).toBe(false);
    expect(ok({ identityFile: "/Users/dev/my key" })).toBe(true);
  });

  it("an RDP username keeps its wider rules (spaces and backslashes are common)", () => {
    expect(profileFieldsSchema.safeParse({ ...RDP_FIELDS, username: "Jane Doe" }).success).toBe(true);
  });
});

describe("the save envelope is strict (P6)", () => {
  it("an extra key beside id and fields is refused", () => {
    expect(profileInputSchema.safeParse({ fields: SSH_FIELDS, password: "x" }).success).toBe(false);
    expect(profileInputSchema.safeParse({ fields: SSH_FIELDS }).success).toBe(true);
  });
});
