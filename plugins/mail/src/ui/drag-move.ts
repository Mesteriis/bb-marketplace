// Drag conversations onto a folder of the rail (slice 3h, #88). The list
// writes a private type carrying this page load's id and the thread ids;
// the rail accepts only that type, and the page only its own id, so a drag
// from another window, another app or a stale page moves nothing. A drop
// becomes the same action the move dialog runs: a role folder takes its
// role action (Trash is Delete, Spam is Spam, Archive is Archive).
import type { MessageAction, SpecialUse } from "../core/index.ts";

/** The private drag type; the rail and the page accept nothing else. */
export const MOVE_TYPE = "application/x-makosh-mail-move";

/** One drop moves at most this many messages, as message_action allows. */
export const MOVE_MAX_MESSAGES = 200;

export const MOVE_TOO_MANY_TEXT = "Move up to 200 at a time";

export type MovePayload = { v: 1; pageId: string; threadIds: string[] };

/** "1 conversation" / "3 conversations". */
export function dragLabel(count: number): string {
  return count === 1 ? "1 conversation" : `${count} conversations`;
}

/** Writes the payload and a text fallback that carries the count only. */
export function writeMovePayload(
  transfer: Pick<DataTransfer, "setData"> & { effectAllowed?: DataTransfer["effectAllowed"] },
  pageId: string,
  threadIds: readonly string[],
): void {
  const payload: MovePayload = { v: 1, pageId, threadIds: [...threadIds] };
  transfer.setData(MOVE_TYPE, JSON.stringify(payload));
  transfer.setData("text/plain", dragLabel(threadIds.length));
  try {
    transfer.effectAllowed = "move";
  } catch {
    // Some engines refuse the write outside dragstart; the drop works without it.
  }
}

/** Whether a drag carries the private type (types are readable during dragover; data is not). */
export function carriesMove(types: Iterable<string> | null | undefined): boolean {
  if (types == null) return false;
  for (const type of types) if (type.toLowerCase() === MOVE_TYPE) return true;
  return false;
}

/**
 * The thread ids of a drop from this page load; null for a foreign type,
 * another page's id, a newer version or anything malformed.
 */
export function readMovePayload(raw: string, pageId: string): string[] | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const payload = parsed as Partial<MovePayload>;
  if (payload.v !== 1 || payload.pageId !== pageId || !Array.isArray(payload.threadIds)) return null;
  const ids = payload.threadIds.filter((id): id is string => typeof id === "string" && id !== "");
  return ids.length > 0 && ids.length === payload.threadIds.length ? [...new Set(ids)] : null;
}

/** What a drop on a folder does: a role action, or a move to the folder. */
export function dropAction(target: { path: string; specialUse: SpecialUse | null }): {
  action: MessageAction;
  destination?: string;
} {
  switch (target.specialUse) {
    case "trash":
      return { action: "delete" };
    case "junk":
      return { action: "spam" };
    case "archive":
      return { action: "archive" };
    default:
      return { action: "move", destination: target.path };
  }
}

/** Why a drop is refused before anything runs, or null. */
export function dropRefusal(messageCount: number): string | null {
  return messageCount > MOVE_MAX_MESSAGES ? MOVE_TOO_MANY_TEXT : null;
}
