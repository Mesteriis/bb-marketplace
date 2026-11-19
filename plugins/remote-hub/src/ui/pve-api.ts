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

export type PveConsoleRequest = { console: "node"; node: string } | { console: "lxc" | "qemu"; vmid: number };

export type PveConsoleOpened = { ok: true; generation: string; sessionId: number; kind: "pve" | "vnc"; /** The node the console was opened on (the guest may have moved since the list was read). */ node: string } | { ok: false; code: string; message: string; fingerprint: string | null };

export interface PveApi {
  targets(input: { profileIds?: string[]; refresh: boolean }): Promise<{ connections: PveConnectionView[] }>;
  pinTrust(profileId: string, fingerprint: string): Promise<unknown>;
  /** Opens a console of a saved connection; the guest's node is looked up again first. */
  openConsole(input: PveConsoleRequest & { profileId: string; cols: number; rows: number }): Promise<PveConsoleOpened>;
  linkGuest(profileId: string, vmid: number, linkProfileId: string | null): Promise<unknown>;
  onboardPlan(input: PveAdminInput): Promise<({ ok: true } & PvePlan) | PveFailure>;
  onboardApply(input: PveAdminInput & { name: string; planDigest: string; replaceRole: boolean }): Promise<{ ok: true; profileId: string; userId: string; steps: PveSteps } | PveFailure>;
  onboardConnect(input: PveEndpointInput & { name: string; authMode: "ticket" | "token"; user: string; secret: string }): Promise<{ ok: true; profileId: string } | { ok: false; code: string; message: string }>;
}
