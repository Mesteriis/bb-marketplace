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
    expect(rpcSchemas.profile_save.input.safeParse({ fields: FIELDS, password: "x" }).success).toBe(false);
  });

  it("ssh_open and rdp_open accept an optional uuid profileId only", () => {
    const rdpTarget = { host: "h.test", username: "u", password: "p" };
    expect(rpcSchemas.rdp_open.input.safeParse({ target: rdpTarget, profileId: "11111111-2222-4333-8444-555555555555" }).success).toBe(true);
    expect(rpcSchemas.rdp_open.input.safeParse({ target: rdpTarget, profileId: "not-a-uuid" }).success).toBe(false);
    expect(rpcSchemas.ssh_open.input.safeParse({ target: { host: "h.test" }, profileId: "11111111-2222-4333-8444-555555555555" }).success).toBe(true);
  });
});

describe("saved credentials in the RPC contract (stage 3b)", () => {
  const target = { host: "h.test", username: "u" };
  const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";

  it("rdp_open takes exactly one of password and credentialRef", () => {
    const ok = (extra: object) => rpcSchemas.rdp_open.input.safeParse({ target: { ...target, ...extra } }).success;
    expect(ok({ password: "p" })).toBe(true);
    expect(ok({ credentialRef: REF })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ password: "p", credentialRef: REF })).toBe(false);
  });

  it("credential_save takes a profile id and a secret and nothing else; the result carries no secret field", () => {
    const input = rpcSchemas.credential_save.input;
    expect(input.safeParse({ profileId: "11111111-2222-4333-8444-555555555555", secret: "x" }).success).toBe(true);
    expect(input.safeParse({ profileId: "11111111-2222-4333-8444-555555555555", secret: "" }).success).toBe(false);
    expect(input.safeParse({ profileId: "11111111-2222-4333-8444-555555555555", secret: "x", host: "evil" }).success).toBe(false);
    expect(Object.keys(rpcSchemas.credential_save.output.shape)).toEqual(["ref"]);
    expect(Object.keys(rpcSchemas.credential_list.output.element.shape)).not.toContain("secret");
  });

  it("there is no RPC that returns a secret", () => {
    expect(Object.keys(rpcSchemas).filter((name) => /secret|reveal|password/.test(name))).toEqual([]);
  });
});
