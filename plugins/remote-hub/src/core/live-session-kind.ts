import type { SessionInfo } from "./rpc.ts";

export type LiveKind = "ssh" | "rdp" | "vnc";

// RDP keeps its handshake and desktop state separately from the process record.
export function canAttachLive(session: Pick<SessionInfo, "kind" | "state" | "rdp"> | undefined, kind: LiveKind): boolean {
  if (!session || session.kind !== kind || session.state === "closed") return false;
  if (kind === "rdp") return session.rdp?.state === "desktop_ready" && session.rdp.desktop !== null;
  return session.state === "running";
}
