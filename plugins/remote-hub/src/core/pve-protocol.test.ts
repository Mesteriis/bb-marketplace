import { describe, expect, it } from "vitest";
import { controlMessageSchema, PROTOCOL_VERSION } from "./protocol.ts";
import { pveConnectSchema } from "./pve-protocol.ts";

const trustPin = { mode: "pin", fingerprint: "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E" };
const connect = { host: "pve.test", port: 8006, authMode: "ticket", user: "remotehub@pve", credentialRef: "rh-cred:v1:local:abc", trust: trustPin };

describe("PVE wire messages (mirror of helper/src/protocol.rs)", () => {
  it("speaks protocol 3", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it("accepts the open_pve request exactly as the helper reads it", () => {
    const msg = { type: "session.open_pve", id: 7, connect, target: { kind: "lxc", node: "pve1", vmid: 101 }, cols: 80, rows: 24 };
    expect(controlMessageSchema.safeParse(msg).success).toBe(true);
    expect(controlMessageSchema.safeParse({ ...msg, target: { kind: "node", node: "pve1" } }).success).toBe(true);
  });

  it("refuses a request that carries both or neither secret source", () => {
    expect(pveConnectSchema.safeParse(connect).success).toBe(true);
    expect(pveConnectSchema.safeParse({ ...connect, password: "x" }).success).toBe(false);
    const { credentialRef: _drop, ...none } = connect;
    expect(pveConnectSchema.safeParse(none).success).toBe(false);
  });

  it("has no trust mode that skips verification", () => {
    expect(pveConnectSchema.safeParse({ ...connect, trust: { mode: "insecure" } }).success).toBe(false);
    expect(pveConnectSchema.safeParse({ ...connect, trust: { mode: "pin", fingerprint: "nope" } }).success).toBe(false);
    expect(pveConnectSchema.safeParse({ ...connect, trust: { mode: "system" } }).success).toBe(true);
  });

  it("accepts provisioning requests and answers, and refuses a save bound to the wrong kind", () => {
    const bind = { type: "endpoint", protocol: "pve", host: "pve.test", port: 8006, user: "remotehub@pve", domain: null };
    const admin = { host: "pve.test", port: 8006, authMode: "ticket", user: "root@pam", password: "x", trust: trustPin };
    const req = { type: "pve.provision", id: 1, connect: admin, dryRun: false, aclPath: "/", save: { ref: "rh-cred:v1:local:abc", bind } };
    expect(controlMessageSchema.safeParse(req).success).toBe(true);
    expect(controlMessageSchema.safeParse({ ...req, dryRun: true, save: undefined }).success).toBe(true);
    expect(controlMessageSchema.safeParse({ type: "pve.plan", id: 1, role: "create", user: "rotate_password", acl: "keep" }).success).toBe(true);
    expect(controlMessageSchema.safeParse({ type: "pve.plan", id: 1, role: "delete", user: "create", acl: "keep" }).success).toBe(false);
    expect(controlMessageSchema.safeParse({ type: "pve.provisioned", id: 1, role: "keep", user: "create", acl: "keep" }).success).toBe(true);
  });

  it("parses the answers the helper sends", () => {
    const result = {
      type: "pve.targets_result",
      id: 1,
      version: "9.0.3",
      nodes: [{ node: "pve1", status: "online" }],
      guests: [{ vmid: 101, name: "web", kind: "lxc", node: "pve1", status: "running", template: false }],
    };
    expect(controlMessageSchema.safeParse(result).success).toBe(true);
    expect(controlMessageSchema.safeParse({ type: "pve.failed", id: 2, code: "tls_untrusted", message: "m", fingerprint: trustPin.fingerprint }).success).toBe(true);
    expect(controlMessageSchema.safeParse({ type: "pve.state", sessionId: 3, state: "open" }).success).toBe(true);
    expect(controlMessageSchema.safeParse({ type: "pve.error", sessionId: 3, code: "login_failed", message: "m" }).success).toBe(true);
  });
});
