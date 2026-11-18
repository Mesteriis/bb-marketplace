// What the Proxmox screens ask of the host, as plain types (host-free). rpc-bridge.ts binds them to the RPC calls.
import type { PveProfileTrust } from "../core/pve-trust.ts";
import type { PveConnectionView } from "../core/pve-targets.ts";
import type { PvePlan, PveSteps } from "../core/pve-protocol.ts";

export interface PveFailure {
  ok: false;
  code: string;
  message: string;
  fingerprint: string | null;
  /** What exists on the server after a partly done setup; null when nothing was attempted. */
  steps?: PveSteps | null;
  /** The connection kept for a partly done setup, so a second run completes it. */
  profileId?: string;
}

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
  userId: string;
}

export interface PveApi {
  targets(input: { profileIds?: string[]; refresh: boolean }): Promise<{ connections: PveConnectionView[] }>;
  pinTrust(profileId: string, fingerprint: string): Promise<unknown>;
  linkGuest(profileId: string, vmid: number, linkProfileId: string | null): Promise<unknown>;
  onboardPlan(input: PveAdminInput): Promise<({ ok: true } & PvePlan) | PveFailure>;
  onboardApply(input: PveAdminInput & { name: string; planDigest: string; replaceRole: boolean }): Promise<{ ok: true; profileId: string; userId: string; steps: PveSteps } | PveFailure>;
  onboardConnect(input: PveEndpointInput & { name: string; authMode: "ticket" | "token"; user: string; secret: string }): Promise<{ ok: true; profileId: string } | { ok: false; code: string; message: string }>;
}
