import { expect, it } from "vitest";
import { decideWriteBack, EditState, writeBackCommand } from "./edit-session.ts";

const first = "65fb3d47-752e-48d8-b4c4-7112e2e4f460";
const second = "3eba1fbe-3842-4081-b33b-8ec4dae644ba";
const base = { size: "3", mtimeNs: "100", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
const updated = { size: "3", mtimeNs: "100", sha256: "3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282" };
const state = { revision: 1, conflict: null, upload: null };
const shown = { id: first, snapshotId: first, proof: base, revision: 1, current: updated, targetKind: "file" } as const;

it("uses the full base as the queue's expected target", () => {
  expect(decideWriteBack(base, state, { revision: 1 }, { kind: "file", fingerprint: base })).toEqual({
    kind: "original", expectTarget: {
      size: "3", mtimeNs: "100", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
  });
});

it("detects a changed digest at identical size and mtime", () => {
  expect(decideWriteBack(base, state, { revision: 1 }, { kind: "file", fingerprint: updated })).toEqual({
    kind: "conflict",
  });
});

it("only takes overwrite against the version displayed with this conflict id", () => {
  const records = { ...state, conflict: shown };
  const destination = { kind: "file", fingerprint: updated } as const;
  expect(decideWriteBack(base, records, { revision: 1, conflictId: second, choice: "overwrite" }, destination))
    .toEqual({ kind: "conflict" });
  expect(decideWriteBack(base, records, { revision: 1, conflictId: first, choice: "overwrite" }, destination))
    .toEqual({ kind: "original", expectTarget: updated });
});

it("a second tab can save a newer revision while the first is deciding", () => {
  const records = { ...state, revision: 2, conflict: shown };
  expect(decideWriteBack(base, records, { revision: 1, conflictId: first, choice: "overwrite" },
    { kind: "file", fingerprint: updated })).toEqual({ kind: "conflict" });
});

it("rechecks absence and requires explicit action to recreate a deleted file", () => {
  const records = { ...state, conflict: { ...shown, current: null, targetKind: null } };
  const request = { revision: 1, conflictId: first, choice: "overwrite" } as const;
  expect(decideWriteBack(base, state, { revision: 1 }, null)).toEqual({ kind: "conflict" });
  expect(decideWriteBack(base, records, request, null)).toEqual({ kind: "original", expectTarget: "absent" });
  expect(decideWriteBack(base, records, request, { kind: "file", fingerprint: updated })).toEqual({ kind: "conflict" });
});

it("never treats a symlink with the displayed fingerprint as a regular file", () => {
  expect(decideWriteBack(base, { ...state, conflict: shown }, {
    revision: 1, conflictId: first, choice: "overwrite",
  }, { kind: "symlink", fingerprint: updated })).toEqual({ kind: "conflict" });
});

it("binds save beside to the shown version as well", () => {
  const request = { revision: 1, conflictId: first, choice: "save-beside" } as const;
  expect(decideWriteBack(base, { ...state, conflict: shown }, request, { kind: "file", fingerprint: base }))
    .toEqual({ kind: "conflict" });
  expect(decideWriteBack(base, { ...state, conflict: shown }, request, { kind: "file", fingerprint: updated }))
    .toEqual({ kind: "beside", expectTarget: "absent" });
});

it("refuses writeback while a revision is uploading", () => {
  expect(() => decideWriteBack(base, {
    ...state, upload: { baseRevision: 1, lastChunkAt: "2026-11-28T00:00:00.000Z" },
  }, { revision: 1 }, null)).toThrow("Дождитесь сохранения");
});

it("rejects unknown persisted state and binds each command field in its receipt", () => {
  expect(EditState.safeParse({ ...state, copyPath: "/foreign" }).success).toBe(false);
  expect(writeBackCommand({ revision: 1, choice: "overwrite", conflictId: first }))
    .toBe('[1,"overwrite","65fb3d47-752e-48d8-b4c4-7112e2e4f460"]');
  expect(writeBackCommand({ revision: 2 })).toBe("[2,null,null]");
});
