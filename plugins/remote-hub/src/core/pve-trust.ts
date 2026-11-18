// How a saved PVE connection trusts the API certificate: the system roots, one CA the owner supplied, or one
// certificate the owner confirmed (its SHA-256 fingerprint). There is no mode that skips verification.
import { z } from "zod";

const fingerprintSchema = z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

export const pveProfileTrustSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("system") }).strict(),
  z.object({ mode: z.literal("ca"), derHex: z.string().regex(/^([0-9a-f]{2})+$/).max(32768) }).strict(),
  z.object({ mode: z.literal("pin"), fingerprint: fingerprintSchema }).strict(),
]);
export type PveProfileTrust = z.infer<typeof pveProfileTrustSchema>;

/** The wire form the helper reads (snake_case `der_hex`). A profile without a stored trust uses the system roots. */
export function pveTrustToWire(trust: PveProfileTrust | null | undefined): { mode: "system" } | { mode: "ca"; der_hex: string } | { mode: "pin"; fingerprint: string } {
  if (trust === null || trust === undefined) return { mode: "system" };
  if (trust.mode === "ca") return { mode: "ca", der_hex: trust.derHex };
  return trust;
}
