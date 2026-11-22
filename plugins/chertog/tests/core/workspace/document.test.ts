// The stored parent of a panel and the version-3 document that carries it.
import { describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/core/layout/index.ts";
import { CHOOSE_PROVIDER } from "../../../src/core/panels/choose.ts";
import {
  dropUnusedPanels, readWorkspaceDocument, registerPanel, removePanelFromLayout, replaceChoosePanel, SCHEMA_VERSION, workspaceDocumentSchema,
} from "../../../src/core/workspace/index.ts";
import type { WorkspaceDocument } from "../../../src/core/workspace/index.ts";

const NO_LIVE: ReadonlySet<string> = new Set();
const thread = (id: string) => ({ ref: { provider: "bb-thread", params: { threadId: "thr_" + id } } });
const RDP = { provider: "remote-rdp-live", params: { resourceRef: "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f" } };

function document(panels: WorkspaceDocument["panels"], placed: string[]): WorkspaceDocument {
  return {
    schemaVersion: 3,
    revision: 0,
    panels,
    layouts: [{ id: "layout-1", name: "Работа", workspace: createWorkspace(placed) }],
    activeLayoutId: "layout-1",
  };
}

describe("schema version 3", () => {
  it("is the version this code writes", () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  it("reads a version-2 document unchanged and saves it as version 3", () => {
    const raw = { ...document({ p: thread("p") }, ["p"]), schemaVersion: 2 };
    const result = readWorkspaceDocument(raw);
    expect(result).toEqual({ status: "ok", document: { ...raw, schemaVersion: 3 }, migratedFrom: 2, dropped: [] });
  });

  it("keeps the parent of a panel through a read", () => {
    const stored = document({ p: thread("p"), c: { ...thread("c"), parent: "p" } }, ["p", "c"]);
    expect(readWorkspaceDocument(stored)).toEqual({ status: "ok", document: stored, migratedFrom: null, dropped: [] });
  });
});

describe("the parent of a panel", () => {
  it("is refused by the schema when it names a panel the document does not know", () => {
    const stored = document({ c: { ...thread("c"), parent: "gone" } }, ["c"]);
    expect(workspaceDocumentSchema.safeParse(stored).success).toBe(false);
  });

  it("is refused by the schema when a panel is its own parent", () => {
    const stored = document({ c: { ...thread("c"), parent: "c" } }, ["c"]);
    expect(workspaceDocumentSchema.safeParse(stored).success).toBe(false);
  });

  it("is dropped by a read when its panel is gone, and the rest is kept", () => {
    const raw = document({ p: { ref: { provider: "bb-thread", params: { threadId: "thr_p", token: "x" } } }, c: { ...thread("c"), parent: "p" } }, ["c"]);
    const result = readWorkspaceDocument(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.document.panels).toEqual({ c: thread("c") });
  });

  it("is refused when a panel is registered with an unknown parent", () => {
    expect(registerPanel(document({}, []), "c", { ...thread("c"), parent: "gone" })).toEqual({ ok: false, reason: "invalid-panel" });
  });

  it("is dropped from a child when its parent leaves the document", () => {
    const stored = document({ p: thread("p"), c: { ...thread("c"), parent: "p" } }, ["p", "c"]);
    const removed = removePanelFromLayout(stored, "p", NO_LIVE);
    expect(removed.ok && removed.document.panels).toEqual({ c: thread("c") });
    expect(removed.ok && workspaceDocumentSchema.safeParse(removed.document).success).toBe(true);
  });

  it("is dropped by dropUnusedPanels when nothing keeps the parent", () => {
    const stored = document({ p: thread("p"), c: { ...thread("c"), parent: "p" } }, ["c"]);
    expect(dropUnusedPanels(stored, NO_LIVE).panels).toEqual({ c: thread("c") });
  });
});

describe("a choice made in a picker with a parent", () => {
  const picker = { ref: { provider: CHOOSE_PROVIDER, params: { kind: "any" } }, parent: "p" };

  it("gives the chosen panel the picker's parent", () => {
    const stored = document({ p: thread("p"), pick: picker }, ["p", "pick"]);
    const chosen = replaceChoosePanel(stored, "pick", "rdp", RDP, NO_LIVE);
    expect(chosen.ok && chosen.document.panels).toEqual({ p: thread("p"), rdp: { ref: RDP, parent: "p" } });
    expect(chosen.ok && workspaceDocumentSchema.safeParse(chosen.document).success).toBe(true);
  });

  it("re-parents a child of the picker to the chosen panel", () => {
    const stored = document({ pick: { ref: { provider: CHOOSE_PROVIDER, params: { kind: "any" } } }, c: { ...thread("c"), parent: "pick" } }, ["pick", "c"]);
    const chosen = replaceChoosePanel(stored, "pick", "rdp", RDP, NO_LIVE);
    expect(chosen.ok && chosen.document.panels.c).toEqual({ ...thread("c"), parent: "rdp" });
    expect(chosen.ok && workspaceDocumentSchema.safeParse(chosen.document).success).toBe(true);
  });
});
