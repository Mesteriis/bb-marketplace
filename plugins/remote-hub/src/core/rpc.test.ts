import { describe, expect, it } from "vitest";
import { rpcSchemas } from "./rpc.ts";

const FIELDS = {
  name: "build",
  protocol: "ssh",
  group: null,
  tags: [],
  favorite: false,
  color: null,
  host: "build.example.test",
  port: null,
  username: null,
  domain: null,
  authType: "agent",
  identityFile: null,
  credentialRef: null,
  rdpWidth: null,
  rdpHeight: null,
};

describe("profile RPC input", () => {
  it("profile_save takes fields and an optional id, and refuses a password anywhere in it", () => {
    expect(rpcSchemas.profile_save.input.safeParse({ fields: FIELDS }).success).toBe(true);
    expect(rpcSchemas.profile_save.input.safeParse({ id: "11111111-2222-4333-8444-555555555555", fields: FIELDS }).success).toBe(true);
    expect(rpcSchemas.profile_save.input.safeParse({ fields: { ...FIELDS, password: "x" } }).success).toBe(false);
    expect(rpcSchemas.profile_save.input.safeParse({ fields: FIELDS, password: "x" }).success).toBe(true); // an outer extra key is dropped, never stored
    expect(rpcSchemas.profile_save.input.parse({ fields: FIELDS, password: "x" })).not.toHaveProperty("password");
  });

  it("ssh_open and rdp_open accept an optional uuid profileId only", () => {
    const rdpTarget = { host: "h.test", username: "u", password: "p" };
    expect(rpcSchemas.rdp_open.input.safeParse({ target: rdpTarget, profileId: "11111111-2222-4333-8444-555555555555" }).success).toBe(true);
    expect(rpcSchemas.rdp_open.input.safeParse({ target: rdpTarget, profileId: "not-a-uuid" }).success).toBe(false);
    expect(rpcSchemas.ssh_open.input.safeParse({ target: { host: "h.test" }, profileId: "11111111-2222-4333-8444-555555555555" }).success).toBe(true);
  });
});
