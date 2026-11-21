// The wire contract of the workspace RPC: what the two methods accept and
// return. Expected values are written out by hand.
import { describe, expect, it } from "vitest";
import {
  loadWorkspaceInputSchema,
  loadWorkspaceOutputSchema,
  saveWorkspaceInputSchema,
  saveWorkspaceOutputSchema,
  workspaceRpcSchemas,
} from "../../../src/core/wire/index.ts";
import { stageADocument, stageAJson } from "../workspace/fixtures.ts";

describe("workspace RPC contract", () => {
  it("has exactly the load and the save method", () => {
    expect(Object.keys(workspaceRpcSchemas)).toEqual(["load_workspace", "save_workspace"]);
    expect(workspaceRpcSchemas.load_workspace.input).toBe(loadWorkspaceInputSchema);
    expect(workspaceRpcSchemas.load_workspace.output).toBe(loadWorkspaceOutputSchema);
    expect(workspaceRpcSchemas.save_workspace.input).toBe(saveWorkspaceInputSchema);
    expect(workspaceRpcSchemas.save_workspace.output).toBe(saveWorkspaceOutputSchema);
  });
});

describe("load_workspace", () => {
  it("takes an empty object and nothing else", () => {
    expect(loadWorkspaceInputSchema.safeParse({}).success).toBe(true);
    expect(loadWorkspaceInputSchema.safeParse({ key: "bb/settings" }).success).toBe(false);
  });

  it("returns each of the four read results", () => {
    const dropped = [
      { kind: "layout", id: "layout-review", name: "Ревью", reason: "the layout is damaged" },
      { kind: "panel", panelId: null, reason: "The panel id is not an identifier" },
    ];
    const results = [
      { status: "empty" },
      { status: "ok", document: stageADocument(), migratedFrom: null, dropped },
      { status: "ok", document: stageADocument(), migratedFrom: 1, dropped: [] },
      { status: "newer", schemaVersion: 2 },
      { status: "corrupt", reason: "The stored workspace is not an object" },
    ];
    for (const result of results) expect(loadWorkspaceOutputSchema.parse(result)).toEqual(result);
  });

  it("refuses a result of another shape", () => {
    expect(loadWorkspaceOutputSchema.safeParse({ status: "ok", document: stageADocument() }).success).toBe(false);
    expect(loadWorkspaceOutputSchema.safeParse({ status: "empty", document: stageADocument() }).success).toBe(false);
    expect(loadWorkspaceOutputSchema.safeParse({ status: "missing" }).success).toBe(false);
  });

  it("refuses to carry a document that breaks the schema", () => {
    const document = stageAJson();
    document.panels["thread-a"].ref.params.token = "hunter2";
    expect(loadWorkspaceOutputSchema.safeParse({ status: "ok", document, migratedFrom: null, dropped: [] }).success).toBe(false);
  });
});

describe("save_workspace", () => {
  it("takes a document and the revision it was made from", () => {
    const input = { document: stageADocument(), expectedRevision: 0 };
    expect(saveWorkspaceInputSchema.parse(input)).toEqual(input);
  });

  it("lets a document that breaks the schema through, so the save answers `rejected` with the reason", () => {
    const document = stageAJson();
    document.panels["thread-a"].ref.params.token = "hunter2";
    expect(saveWorkspaceInputSchema.safeParse({ document, expectedRevision: 3 }).success).toBe(true);
  });

  it("refuses a revision that is not a whole number from 0, and unknown fields", () => {
    const document = stageADocument();
    expect(saveWorkspaceInputSchema.safeParse({ document, expectedRevision: -1 }).success).toBe(false);
    expect(saveWorkspaceInputSchema.safeParse({ document, expectedRevision: 1.5 }).success).toBe(false);
    expect(saveWorkspaceInputSchema.safeParse({ document, expectedRevision: "1" }).success).toBe(false);
    expect(saveWorkspaceInputSchema.safeParse({ document }).success).toBe(false);
    expect(saveWorkspaceInputSchema.safeParse({ document, expectedRevision: 0, key: "bb/settings" }).success).toBe(false);
  });

  it("returns saved, conflict with the stored document or with nothing, and rejected with a reason", () => {
    const results = [
      { status: "saved", document: { ...stageADocument(), revision: 1 } },
      { status: "conflict", current: { ...stageADocument(), revision: 4 } },
      { status: "conflict", current: null },
      { status: "rejected", reason: "the document carries a credential" },
    ];
    for (const result of results) expect(saveWorkspaceOutputSchema.parse(result)).toEqual(result);
  });

  it("refuses a result of another shape", () => {
    expect(saveWorkspaceOutputSchema.safeParse({ status: "saved" }).success).toBe(false);
    expect(saveWorkspaceOutputSchema.safeParse({ status: "conflict" }).success).toBe(false);
    expect(saveWorkspaceOutputSchema.safeParse({ status: "rejected" }).success).toBe(false);
    expect(saveWorkspaceOutputSchema.safeParse({ status: "saved", document: stageADocument(), reason: "extra" }).success).toBe(false);
  });
});
