/**
 * Sender side of the public `chertog.open.v1` protocol (see plugins/chertog/docs/open-wire-v1.md).
 * The shape is copied here on purpose: plugins never import each other.
 */
interface OpenThreadDetail {
  kind: 'thread';
  threadId: string;
  accepted: boolean;
  outcome: string | null;
}

/** True when an open Chertog workspace page handled the request and the caller must not navigate. */
export function requestChertogTile(threadId: string): boolean {
  const detail: OpenThreadDetail = { kind: 'thread', threadId, accepted: false, outcome: null };
  try {
    window.dispatchEvent(new CustomEvent('chertog.open.v1', { detail }));
  } catch {
    return false;
  }
  return detail.accepted === true;
}
