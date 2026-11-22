import { describe, expect, it } from "vitest";
import { listGroups } from "../../../src/core/layout/index.ts";
import { chooseProvider } from "../../../src/core/panels/choose.ts";
import { activeLayout, workspaceDocumentSchema } from "../../../src/core/workspace/document.ts";
import { applyPreset } from "../../../src/core/workspace/presets.ts";
import { duplicateLayout, replaceChoosePanel, type WorkspaceChange } from "../../../src/core/workspace/operations.ts";
import { stageADocument } from "./fixtures.ts";

function changed(change: WorkspaceChange) {
  if (!change.ok) throw Error(change.reason);
  return change.document;
}

const choose = (kind: string) => ({ provider: "chertog-choose", params: { kind } });
const card = (provider: string) => ({ provider, params: {} });

describe("workspace presets", () => {
  it.each([
    ["agents", "Команда агентов", [choose("bb-thread"), choose("bb-diff"), choose("bb-thread"), choose("bb-file-preview")]],
    ["administration", "Администрирование", [card("remote-ssh"), card("remote-rdp"), card("remote-vnc"), choose("bb-terminal")]],
    ["call", "Созвон", [card("zoom"), choose("bb-thread"), card("telegram")]],
  ] as const)("creates the %s tiles in a valid v2 document", (preset, name, expected) => {
    const original = stageADocument();
    const document = changed(applyPreset(original, "layout-new", preset));
    expect(workspaceDocumentSchema.safeParse(document).success).toBe(true);
    const layout = activeLayout(document);
    expect([layout.id, layout.name]).toEqual(["layout-new", name]);
    expect(listGroups(layout.workspace.root).map(group => group.tabs.map(id => document.panels[id].ref)))
      .toEqual(expected.map(ref => [ref]));
    expect(document.layouts.slice(0, 2)).toEqual(stageADocument().layouts);
    expect(original).toEqual(stageADocument());
  });

  it("allocates names across case and occupied suffixes; refuses an existing layout id", () => {
    const first = changed(duplicateLayout(stageADocument(), "layout-dev", "copy", "СОЗВОН"));
    const second = changed(applyPreset(first, "another", "call"));
    const third = changed(applyPreset(second, "last", "call"));
    expect(third.layouts.map(layout => layout.name)).toEqual(["Разработка", "СОЗВОН", "Ревью", "Созвон 2", "Созвон 3"]);
    expect(applyPreset(third, "copy", "call")).toEqual({ ok: false, reason: "layout-exists" });
  });

  it("replaces only the requested placement even if another layout shares its chooser", () => {
    const first = changed(applyPreset(stageADocument(), "call", "call"));
    const copy = changed(duplicateLayout(first, "call", "copy", "Копия"));
    const groups = listGroups(activeLayout(copy).workspace.root);
    const slot = groups[1].activeTab!;
    const ref = { provider: "bb-thread", params: { threadId: "thr_a" } };
    const result = changed(replaceChoosePanel(copy, slot, "thread-a", ref, new Set()));
    expect(listGroups(activeLayout(result).workspace.root)[1]).toEqual({
      ...groups[1], tabs: ["thread-a"], activeTab: "thread-a",
    });
    expect(result.layouts.slice(0, 3)).toEqual(copy.layouts.slice(0, 3));
    expect(result.panels[slot].ref).toEqual(choose("bb-thread"));
    expect(workspaceDocumentSchema.safeParse(result).success).toBe(true);
    expect(replaceChoosePanel(result, slot, "thread-b", ref, new Set())).toEqual({ ok: false, reason: "not-placed" });
  });

  it("rejects mismatched providers and missing or unsafe targets atomically", () => {
    const created = changed(applyPreset(stageADocument(), "new", "administration"));
    const slot = listGroups(activeLayout(created).workspace.root)[3].activeTab!;
    for (const ref of [card("bb-thread"), card("bb-terminal"), { provider: "bb-terminal", params: { terminalId: "bad value" } }]) {
      expect(replaceChoosePanel(created, slot, "selected", ref, new Set())).toEqual({ ok: false, reason: "invalid-panel" });
    }
    expect(created.panels[slot].ref).toEqual(choose("bb-terminal"));
    expect(created.panels.selected).toBeUndefined();
  });

  it("uses a distinct chooser per placement and drops only the replaced entry", () => {
    const doc = changed(applyPreset(stageADocument(), "agents", "agents"));
    const groups = listGroups(activeLayout(doc).workspace.root);
    const first = groups[0].activeTab!;
    const other = groups[2].activeTab!;
    expect(first).not.toBe(other);
    const picked = changed(replaceChoosePanel(doc, first, "selected", {
      provider: "bb-thread", params: { threadId: "thr_selected" },
    }, new Set()));
    expect(picked.panels[first]).toBeUndefined();
    expect(picked.panels[other].ref).toEqual(choose("bb-thread"));
    expect(activeLayout(picked).workspace.focusedGroupId).toBe(groups[0].id);
    expect(listGroups(activeLayout(picked).workspace.root)[0]).toEqual({
      kind: "group", id: groups[0].id, tabs: ["selected"], activeTab: "selected",
    });
    expect(picked.panels.selected.ref).toEqual({ provider: "bb-thread", params: { threadId: "thr_selected" } });
  });

  it("opens a chooser as an entry with independent views and no external session", async () => {
    expect(chooseProvider.multipleViews).toBe(true);
    expect(chooseProvider.endsSessionOnLastClose(choose("bb-terminal"))).toBe(false);
    for (const kind of ["bb-thread", "bb-file-preview", "bb-diff", "bb-terminal"]) {
      expect(await chooseProvider.open({ instanceId: "view", ref: choose(kind) })).toEqual({ status: "entry" });
    }
    for (const ref of [choose("zoom"), { provider: "chertog-choose", params: { kind: "bb-thread", threadId: "extra" } }]) {
      expect(await chooseProvider.open({ instanceId: "view", ref })).toEqual({ status: "access-denied" });
    }
  });
});
