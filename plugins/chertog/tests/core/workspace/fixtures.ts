// Literal documents for the workspace tests. Each call returns a fresh copy,
// written out by hand: nothing here is produced by the code under test.
import type { WorkspaceDocument, WorkspaceReadResult, WorkspaceSaveResult, WorkspaceStore } from "../../../src/core/workspace/index.ts";
import { decideSave, readWorkspaceDocument } from "../../../src/core/workspace/index.ts";

/**
 * Stage A of the spec: two BB threads and the controlled frame. "Разработка"
 * shows all three, thread A on the left and the frame bottom right. "Ревью"
 * shows the frame on the left and thread A on the right; thread B is hidden.
 */
export function stageADocument(): WorkspaceDocument {
  return {
    schemaVersion: 2,
    revision: 0,
    panels: {
      "thread-a": { ref: { provider: "bb-thread", params: { threadId: "thr_a" } } },
      "thread-b": { ref: { provider: "bb-thread", params: { threadId: "thr_b" } } },
      frame: { ref: { provider: "chertog-frame", params: { frameId: "live-frame" } } },
    },
    layouts: [
      {
        id: "layout-dev",
        name: "Разработка",
        workspace: {
          root: {
            kind: "split",
            id: "split-3",
            direction: "row",
            children: [
              { kind: "group", id: "group-1", tabs: ["thread-a"], activeTab: "thread-a" },
              {
                kind: "split",
                id: "split-5",
                direction: "column",
                children: [
                  { kind: "group", id: "group-2", tabs: ["thread-b"], activeTab: "thread-b" },
                  { kind: "group", id: "group-4", tabs: ["frame"], activeTab: "frame" },
                ],
                sizes: [0.5, 0.5],
              },
            ],
            sizes: [0.5, 0.5],
          },
          focusedGroupId: "group-4",
          maximizedGroupId: null,
          nextNodeId: 6,
        },
      },
      {
        id: "layout-review",
        name: "Ревью",
        workspace: {
          root: {
            kind: "split",
            id: "split-3",
            direction: "row",
            children: [
              { kind: "group", id: "group-1", tabs: ["frame"], activeTab: "frame" },
              { kind: "group", id: "group-2", tabs: ["thread-a"], activeTab: "thread-a" },
            ],
            sizes: [0.5, 0.5],
          },
          focusedGroupId: "group-2",
          maximizedGroupId: null,
          nextNodeId: 4,
        },
      },
    ],
    activeLayoutId: "layout-review",
  };
}

/** The stage A document as storage returns it: untyped JSON, so a test can damage any part of it. */
export function stageAJson(): any {
  return JSON.parse(JSON.stringify(stageADocument()));
}

/** A store that keeps one JSON string, the way a host key-value store does. */
export class MemoryWorkspaceStore implements WorkspaceStore {
  json: string | null = null;

  async load(): Promise<WorkspaceReadResult> {
    return readWorkspaceDocument(this.json === null ? null : JSON.parse(this.json));
  }

  async save(document: WorkspaceDocument, expectedRevision: number): Promise<WorkspaceSaveResult> {
    const stored = await this.load();
    if (stored.status !== "ok" && stored.status !== "empty") throw new Error("the test store holds an unreadable document");
    const result = decideSave(stored.status === "ok" ? stored.document : null, document, expectedRevision);
    if (result.status === "saved") this.json = JSON.stringify(result.document);
    return result;
  }
}
