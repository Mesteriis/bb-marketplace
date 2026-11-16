import { describe, expect, it } from "vitest";
import {
  carriesMove,
  dragLabel,
  dropAction,
  dropRefusal,
  MOVE_TOO_MANY_TEXT,
  MOVE_TYPE,
  readMovePayload,
  writeMovePayload,
} from "./drag-move.ts";

function transfer() {
  const data = new Map<string, string>();
  return {
    data,
    effectAllowed: "all" as DataTransfer["effectAllowed"],
    setData(type: string, value: string) {
      data.set(type, value);
    },
  };
}

describe("drag payload", () => {
  it("writes the private type with this page's id and a count-only text fallback", () => {
    const t = transfer();
    writeMovePayload(t, "page-1", ["th-a", "th-b", "th-c"]);
    expect(JSON.parse(t.data.get(MOVE_TYPE)!)).toEqual({ v: 1, pageId: "page-1", threadIds: ["th-a", "th-b", "th-c"] });
    expect(t.data.get("text/plain")).toBe("3 conversations");
    expect(t.effectAllowed).toBe("move");
    expect(dragLabel(1)).toBe("1 conversation");
  });

  it("reads only this page's payload", () => {
    const t = transfer();
    writeMovePayload(t, "page-1", ["th-a"]);
    const raw = t.data.get(MOVE_TYPE)!;
    expect(readMovePayload(raw, "page-1")).toEqual(["th-a"]);
    // Another page load, a newer version, plain text, junk: nothing moves.
    expect(readMovePayload(raw, "page-2")).toBeNull();
    expect(readMovePayload(JSON.stringify({ v: 2, pageId: "page-1", threadIds: ["th-a"] }), "page-1")).toBeNull();
    expect(readMovePayload("3 conversations", "page-1")).toBeNull();
    expect(readMovePayload("", "page-1")).toBeNull();
    expect(readMovePayload(JSON.stringify({ v: 1, pageId: "page-1", threadIds: [] }), "page-1")).toBeNull();
    expect(readMovePayload(JSON.stringify({ v: 1, pageId: "page-1", threadIds: ["a", 3] }), "page-1")).toBeNull();
  });

  it("accepts a drag over the rail only with the private type", () => {
    expect(carriesMove([MOVE_TYPE, "text/plain"])).toBe(true);
    expect(carriesMove(["text/plain"])).toBe(false);
    expect(carriesMove(["Files"])).toBe(false);
    expect(carriesMove(null)).toBe(false);
  });
});

describe("drop targets", () => {
  it("maps role folders to role actions and others to a move", () => {
    expect(dropAction({ path: "Trash", specialUse: "trash" })).toEqual({ action: "delete" });
    expect(dropAction({ path: "Junk", specialUse: "junk" })).toEqual({ action: "spam" });
    expect(dropAction({ path: "Archive", specialUse: "archive" })).toEqual({ action: "archive" });
    expect(dropAction({ path: "Projects", specialUse: null })).toEqual({ action: "move", destination: "Projects" });
    expect(dropAction({ path: "INBOX", specialUse: "inbox" })).toEqual({ action: "move", destination: "INBOX" });
  });

  it("refuses 201 messages and allows 200", () => {
    expect(dropRefusal(200)).toBeNull();
    expect(dropRefusal(201)).toBe(MOVE_TOO_MANY_TEXT);
  });
});
