import { createHash } from "node:crypto";
import { setSha256Factory } from "../../core/reconcile.ts";

/** Routes the core's streaming SHA-256 (transfer proofs, checksums) to node:crypto. Idempotent. */
export function installNativeSha256(): void {
  setSha256Factory(() => {
    const hash = createHash("sha256");
    return { update: (bytes) => { hash.update(bytes); }, finish: () => hash.digest("hex") };
  });
}
