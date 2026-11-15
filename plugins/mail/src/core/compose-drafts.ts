// When a draft's copy in the account's Drafts folder is due. The local row is
// the copy that protects against lost text; the server copy follows it, and
// only on servers where the previous copy can be removed by UID (UIDPLUS).

/** How long a draft must be idle before a background tick copies it to the server. */
export const SERVER_COPY_IDLE_MS = 30_000;

/**
 * Why a server copy is considered: a background tick, the composer closing,
 * an explicit Save draft, a send (which skips it) or a discard (which
 * removes the copy instead of writing one).
 */
export type ServerCopyReason = "tick" | "close" | "save" | "send" | "discard";

export type ServerCopyCheck = {
  /** The draft's current revision. */
  revision: number;
  /** The revision its server copy holds, or null without one. */
  serverRevision: number | null;
  /** ISO 8601 of the last local save. */
  updatedAt: string;
  /** Now, ISO 8601. */
  now: string;
  hasAttachments: boolean;
  uidplus: boolean;
  hasDraftsFolder: boolean;
  reason: ServerCopyReason;
};

/**
 * True when the server copy should be written now. Never without UIDPLUS or
 * a Drafts folder (each copy would be left behind); never for a send or a
 * discard; never when the server already holds this revision, nor before
 * the owner's first save (revision 1 has no server copy to follow). With
 * attachments only on close and Save draft; a tick only after 30 s idle.
 */
export function serverCopyDue(check: ServerCopyCheck): boolean {
  if (!check.uidplus || !check.hasDraftsFolder) return false;
  if (check.reason === "send" || check.reason === "discard") return false;
  if (check.serverRevision !== null && check.serverRevision >= check.revision) return false;
  // Revision 1 is the draft as created (an import does not bump it): the owner has not saved it yet.
  if (check.serverRevision === null && check.revision <= 1) return false;
  if (check.reason === "close" || check.reason === "save") return true;
  if (check.hasAttachments) return false;
  const idle = Date.parse(check.now) - Date.parse(check.updatedAt);
  return Number.isFinite(idle) && idle >= SERVER_COPY_IDLE_MS;
}
