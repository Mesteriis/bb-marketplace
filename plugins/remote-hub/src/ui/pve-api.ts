// What the Proxmox screens ask of the host, as plain types (host-free). rpc-bridge.ts binds them to the RPC calls.
import type { PveProfileTrust } from "../core/pve-trust.ts";
import type { PveConnectionView } from "../core/pve-targets.ts";

export interface PveFailure {
  ok: false;
  code: string;
  message: string;
  fingerprint: string | null;
}

export type PveAction = "create" | "keep" | "update" | "rotate_password";

export interface PveEndpointInput {
  host: string;
  port: number;
  /** null = the system roots. */
  trust: PveProfileTrust | null;
}

export interface PveAdminInput extends PveEndpointInput {
  adminUser: string;
  adminPassword: string;
  aclPath: string;
}

export interface PveApi {
  targets(input: { profileIds?: string[]; refresh: boolean }): Promise<{ connections: PveConnectionView[] }>;
  pinTrust(profileId: string, fingerprint: string): Promise<unknown>;
  linkGuest(profileId: string, vmid: number, linkProfileId: string | null): Promise<unknown>;
  onboardPlan(input: PveAdminInput): Promise<{ ok: true; role: PveAction; user: PveAction; acl: PveAction } | PveFailure>;
  onboardApply(input: PveAdminInput & { name: string }): Promise<{ ok: true; profileId: string; role: PveAction; user: PveAction; acl: PveAction } | PveFailure>;
  onboardConnect(input: PveEndpointInput & { name: string; authMode: "ticket" | "token"; user: string; secret: string }): Promise<{ ok: true; profileId: string } | { ok: false; code: string; message: string }>;
}
